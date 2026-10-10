#!/usr/bin/env python3
"""Local pyttsx3 voice service for the Queue Display computer.

Run this script on the same computer that has the Queue Display speakers.
The browser page sends accepted-patient announcements to this local service.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

try:
    import pyttsx3
except ImportError:  # pragma: no cover - exercised when dependency is missing
    pyttsx3 = None

try:
    import pythoncom
except ImportError:  # pragma: no cover - pywin32 is installed with pyttsx3 on Windows
    pythoncom = None


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_RATE = 165
DEFAULT_VOLUME = 1.0
DEFAULT_DEDUPE_SECONDS = 60 * 60
DEFAULT_RESET_ENGINE_AFTER_SPEAK = True
MAX_SPEAK_ATTEMPTS = 2
MIN_AUDIBLE_DURATION_MS = 700
MAX_BODY_BYTES = 16 * 1024


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def safe_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def log_event(stage: str, **details: Any) -> None:
    safe_details = {}
    for key, value in details.items():
        try:
            json.dumps(value)
            safe_details[key] = value
        except TypeError:
            safe_details[key] = str(value)
    print(
        json.dumps(
            {
                "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "stage": stage,
                **safe_details,
            },
            separators=(",", ":"),
        ),
        flush=True,
    )


def build_spoken_queue(queue_number: Any) -> str:
    value = str(queue_number or "").strip()
    if not value:
        return ""
    return " ".join(character for character in value.replace("-", "") if not character.isspace())


def build_announcement_text(payload: dict[str, Any]) -> str:
    text = str(payload.get("text") or "").strip()
    if text:
        return text

    queue_number = build_spoken_queue(payload.get("queue_number"))
    patient_name = str(payload.get("patient_name") or "").strip()
    doctor_name = str(payload.get("doctor_name") or "Doctor").strip()
    room = str(payload.get("room") or "").strip()
    destination = f"{doctor_name}, {room}" if room else doctor_name

    if patient_name:
        return f"Now calling queue number {queue_number}, {patient_name}, please proceed to {destination}."
    return f"Now calling queue number {queue_number}, please proceed to {destination}."


def key_for_payload(payload: dict[str, Any], text: str) -> str:
    key = str(payload.get("key") or "").strip()
    if key:
        return key
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return f"text:{digest}"


class TtsState:
    def __init__(
        self,
        rate: int,
        volume: float,
        dedupe_seconds: int,
        dry_run: bool = False,
        reset_engine_after_speak: bool = True,
    ) -> None:
        self.rate = rate
        self.volume = max(0.0, min(1.0, volume))
        self.dedupe_seconds = max(1, dedupe_seconds)
        self.dry_run = dry_run
        self.reset_engine_after_speak = reset_engine_after_speak
        self.queue: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self.lock = threading.Lock()
        self.seen: dict[str, float] = {}
        self.pending: set[str] = set()
        self.engine: Any = None
        self.engine_generation = 0
        self.speaking_key: str | None = None
        self.last_error: str | None = None
        self.stop_event = threading.Event()
        self.audio_thread_name: str | None = None
        self.com_initialized = False

    def health(self, init_engine: bool = False) -> dict[str, Any]:
        ready = pyttsx3 is not None
        warmup_error: str | None = None
        if init_engine and ready:
            warmup = self.warm_up()
            if not warmup.get("success"):
                ready = False
                warmup_error = warmup.get("error") or "pyttsx3 warm-up failed"

        with self.lock:
            speaking_key = self.speaking_key
            last_error = warmup_error or self.last_error
            seen_count = len(self.seen)
            pending_count = len(self.pending)
        return {
            "success": True,
            "engine": "pyttsx3",
            "ready": ready,
            "dry_run": self.dry_run,
            "queue_length": self.queue.qsize(),
            "speaking": bool(speaking_key),
            "speaking_key": speaking_key,
            "seen_count": seen_count,
            "pending_count": pending_count,
            "last_error": last_error,
            "process_id": os.getpid(),
            "audio_thread": self.audio_thread_name,
            "reset_engine_after_speak": self.reset_engine_after_speak,
            "engine_generation": self.engine_generation,
        }

    def warm_up(self, timeout_seconds: float = 5.0) -> dict[str, Any]:
        if pyttsx3 is None:
            return {
                "success": False,
                "error": "pyttsx3 is not installed. Run: python -m pip install -r backend/voice/requirements.txt",
            }
        if self.dry_run or self.engine is not None:
            return {"success": True}

        log_event("warm-up-queued", timeout_seconds=timeout_seconds)
        done_event = threading.Event()
        result: dict[str, Any] = {}
        self.queue.put({
            "key": "__warmup__",
            "warm_up": True,
            "done_event": done_event,
            "result": result,
            "gap_ms": 0,
        })
        completed = done_event.wait(timeout_seconds)
        if not completed:
            log_event("warm-up-timeout", timeout_seconds=timeout_seconds)
            return {"success": False, "error": "Timed out warming up pyttsx3"}
        if result.get("error"):
            log_event("warm-up-error", error=result["error"])
            return {"success": False, "error": result["error"]}
        log_event("warm-up-ok")
        return {"success": True}

    def enqueue(self, payload: dict[str, Any]) -> dict[str, Any]:
        if pyttsx3 is None:
            return {
                "success": False,
                "queued": False,
                "error": "pyttsx3 is not installed. Run: python -m pip install -r backend/voice/requirements.txt",
            }

        text = build_announcement_text(payload)
        if not text:
            return {"success": False, "queued": False, "error": "Announcement text is required"}

        key = key_for_payload(payload, text)
        wait = bool(payload.get("wait"))
        done_event = threading.Event() if wait else None
        result: dict[str, Any] = {}
        now = time.time()

        with self.lock:
            self._prune_seen_locked(now)
            if key in self.seen or key in self.pending:
                log_event("enqueue-duplicate", key=key, queue_number=payload.get("queue_number"))
                return {"success": True, "queued": False, "duplicate": True, "key": key}
            self.pending.add(key)

        item = {
            "key": key,
            "text": text,
            "gap_ms": max(0, safe_int(payload.get("gap_ms"), 0)),
            "done_event": done_event,
            "result": result,
        }
        self.queue.put(item)
        log_event(
            "enqueue-ok",
            key=key,
            queue_number=payload.get("queue_number"),
            patient_name=payload.get("patient_name"),
            doctor_name=payload.get("doctor_name"),
            room=payload.get("room"),
            wait=wait,
            queue_length=self.queue.qsize(),
            text=text,
        )

        if done_event:
            timeout_seconds = max(5, safe_float(payload.get("timeout_seconds"), 45.0))
            completed = done_event.wait(timeout_seconds)
            if not completed:
                return {
                    "success": False,
                    "queued": True,
                    "key": key,
                    "error": "Timed out waiting for pyttsx3 to finish speaking",
                }
            if result.get("error"):
                return {"success": False, "queued": True, "key": key, "error": result["error"]}

        return {"success": True, "queued": True, "duplicate": False, "key": key}

    def _prune_seen_locked(self, now: float) -> None:
        cutoff = now - self.dedupe_seconds
        expired = [key for key, seen_at in self.seen.items() if seen_at < cutoff]
        for key in expired:
            self.seen.pop(key, None)

    def _get_engine(self) -> Any:
        if self.engine is None:
            log_event("engine-init-start", rate=self.rate, volume=self.volume)
            self.engine = pyttsx3.init()
            self.engine_generation += 1
            self.engine.setProperty("rate", self.rate)
            self.engine.setProperty("volume", self.volume)
            self._attach_engine_callbacks(self.engine_generation)
            log_event("engine-init-ok")
        return self.engine

    def _attach_engine_callbacks(self, generation: int) -> None:
        if not self.engine:
            return
        try:
            self.engine.connect(
                "started-utterance",
                lambda name: log_event("utterance-started", name=name, engine_generation=generation),
            )
            self.engine.connect(
                "finished-utterance",
                lambda name, completed: log_event(
                    "utterance-finished",
                    name=name,
                    completed=completed,
                    engine_generation=generation,
                ),
            )
            self.engine.connect(
                "error",
                lambda name, exception: log_event(
                    "utterance-error",
                    name=name,
                    error=str(exception),
                    engine_generation=generation,
                ),
            )
        except Exception as exc:
            log_event("engine-callback-attach-error", error=str(exc))

    def _dispose_engine(self, reason: str) -> None:
        if self.engine is None:
            return
        generation = self.engine_generation
        try:
            self.engine.stop()
        except Exception as exc:
            log_event("engine-stop-error", reason=reason, engine_generation=generation, error=str(exc))
        self.engine = None
        log_event("engine-disposed", reason=reason, engine_generation=generation)

    def _minimum_expected_duration_ms(self, text: str) -> int:
        # pyttsx3's runAndWait should block while SAPI speaks. When it returns
        # in only a few hundred milliseconds for a full queue announcement, the
        # local SAPI engine usually accepted the command but produced no audio.
        return max(MIN_AUDIBLE_DURATION_MS, min(1800, len(text) * 8))

    def _initialize_audio_thread(self) -> None:
        if pythoncom is None or self.com_initialized:
            return
        try:
            pythoncom.CoInitialize()
            self.com_initialized = True
            log_event("com-initialize-ok", audio_thread=threading.current_thread().name)
        except Exception as exc:
            log_event("com-initialize-error", error=str(exc))

    def _uninitialize_audio_thread(self) -> None:
        if pythoncom is None or not self.com_initialized:
            return
        try:
            pythoncom.CoUninitialize()
            log_event("com-uninitialize-ok", audio_thread=threading.current_thread().name)
        except Exception as exc:
            log_event("com-uninitialize-error", error=str(exc))
        finally:
            self.com_initialized = False

    def _speak(self, text: str, key: str | None = None) -> None:
        if self.dry_run:
            print(f"[pyttsx3 dry-run] {text}", flush=True)
            time.sleep(0.05)
            return

        minimum_duration_ms = self._minimum_expected_duration_ms(text)
        last_error: Exception | None = None

        for attempt in range(1, MAX_SPEAK_ATTEMPTS + 1):
            engine = self._get_engine()
            started = time.monotonic()
            generation = self.engine_generation
            log_event(
                "speak-run-start",
                key=key,
                engine_generation=generation,
                attempt=attempt,
                min_duration_ms=minimum_duration_ms,
                text=text,
            )

            try:
                engine.say(text, name=key or "")
                engine.runAndWait()
                duration_ms = round((time.monotonic() - started) * 1000)

                if duration_ms < minimum_duration_ms:
                    raise RuntimeError(
                        "pyttsx3 runAndWait returned too quickly "
                        f"({duration_ms}ms < {minimum_duration_ms}ms); treating as silent playback"
                    )

                log_event(
                    "speak-run-ok",
                    key=key,
                    engine_generation=generation,
                    attempt=attempt,
                    duration_ms=duration_ms,
                )
                if self.reset_engine_after_speak:
                    self._dispose_engine("after-speak")
                return
            except Exception as exc:
                last_error = exc
                log_event(
                    "speak-run-error",
                    key=key,
                    engine_generation=generation,
                    attempt=attempt,
                    error=str(exc),
                )
                self._dispose_engine("speak-retry" if attempt < MAX_SPEAK_ATTEMPTS else "speak-failed")
                if attempt < MAX_SPEAK_ATTEMPTS:
                    time.sleep(0.25)

        if last_error:
            raise last_error

    def stop(self) -> None:
        self.stop_event.set()
        self.queue.put(None)

    def run_forever(self) -> None:
        self.audio_thread_name = threading.current_thread().name
        log_event("audio-loop-start", audio_thread=self.audio_thread_name, process_id=os.getpid())
        self._initialize_audio_thread()
        try:
            while not self.stop_event.is_set():
                item = self.queue.get()
                if item is None:
                    self.queue.task_done()
                    break
                key = item.get("key")
                with self.lock:
                    self.speaking_key = key
                    self.last_error = None

                try:
                    if item.get("warm_up"):
                        if not self.dry_run:
                            self._get_engine()
                            if self.reset_engine_after_speak:
                                self._dispose_engine("after-warm-up")
                    else:
                        log_event("queue-item-start", key=key)
                        self._speak(str(item.get("text") or ""), key=str(key or ""))
                    item["result"]["success"] = True
                    if key and not item.get("warm_up"):
                        with self.lock:
                            self.seen[str(key)] = time.time()
                        log_event("queue-item-ok", key=key)
                except Exception as exc:  # pragma: no cover - depends on local audio stack
                    error = str(exc) or exc.__class__.__name__
                    item["result"]["error"] = error
                    with self.lock:
                        self.last_error = error
                    print(f"[pyttsx3 error] {error}", file=sys.stderr, flush=True)
                    log_event("queue-item-error", key=key, error=error)
                    self._dispose_engine("error")
                finally:
                    with self.lock:
                        self.speaking_key = None
                        if key:
                            self.pending.discard(str(key))
                    done_event = item.get("done_event")
                    if done_event:
                        done_event.set()
                    gap_ms = safe_int(item.get("gap_ms"), 0)
                    self.queue.task_done()
                    if gap_ms > 0 and not self.queue.empty():
                        time.sleep(gap_ms / 1000)
        finally:
            self._dispose_engine("shutdown")
            self._uninitialize_audio_thread()


class TtsRequestHandler(BaseHTTPRequestHandler):
    server_version = "QueuePyttsx3Tts/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}", flush=True)

    @property
    def state(self) -> TtsState:
        return self.server.state  # type: ignore[attr-defined]

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self._send_json(204, {})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            init_value = parse_qs(parsed.query).get("init", ["0"])[0]
            init_engine = init_value.strip().lower() in {"1", "true", "yes", "on"}
            health = self.state.health(init_engine=init_engine)
            log_event("health", init_engine=init_engine, ready=health.get("ready"), last_error=health.get("last_error"))
            self._send_json(200, health)
            return
        self._send_json(404, {"success": False, "error": "Not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path != "/speak":
            self._send_json(404, {"success": False, "error": "Not found"})
            return

        length = safe_int(self.headers.get("Content-Length"), 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send_json(400, {"success": False, "error": "Invalid request body"})
            return

        try:
            raw = self.rfile.read(length).decode("utf-8")
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("JSON body must be an object")
        except Exception as exc:
            self._send_json(400, {"success": False, "error": f"Invalid JSON: {exc}"})
            return

        log_event(
            "speak-request",
            key=payload.get("key"),
            queue_number=payload.get("queue_number"),
            patient_name=payload.get("patient_name"),
            doctor_name=payload.get("doctor_name"),
            room=payload.get("room"),
            wait=payload.get("wait"),
        )
        result = self.state.enqueue(payload)
        log_event("speak-response", key=result.get("key"), success=result.get("success"), duplicate=result.get("duplicate"), error=result.get("error"))
        self._send_json(200 if result.get("success") else 500, result)


class TtsServer(ThreadingHTTPServer):
    def __init__(self, server_address: tuple[str, int], handler_class: type[TtsRequestHandler], state: TtsState) -> None:
        super().__init__(server_address, handler_class)
        self.state = state


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local pyttsx3 TTS service for Queue Display announcements.")
    parser.add_argument("--host", default=os.getenv("PYTTSX3_TTS_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=safe_int(os.getenv("PYTTSX3_TTS_PORT"), DEFAULT_PORT))
    parser.add_argument("--rate", type=int, default=safe_int(os.getenv("PYTTSX3_TTS_RATE"), DEFAULT_RATE))
    parser.add_argument("--volume", type=float, default=safe_float(os.getenv("PYTTSX3_TTS_VOLUME"), DEFAULT_VOLUME))
    parser.add_argument(
        "--dedupe-seconds",
        type=int,
        default=safe_int(os.getenv("PYTTSX3_TTS_DEDUPE_SECONDS"), DEFAULT_DEDUPE_SECONDS),
    )
    parser.add_argument("--dry-run", action="store_true", default=env_bool("PYTTSX3_TTS_DRY_RUN"))
    parser.add_argument(
        "--keep-engine",
        action="store_true",
        default=env_bool("PYTTSX3_TTS_KEEP_ENGINE"),
        help="Reuse the pyttsx3 engine across announcements. Default is to reset it after each item.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    state = TtsState(
        rate=args.rate,
        volume=args.volume,
        dedupe_seconds=args.dedupe_seconds,
        dry_run=args.dry_run,
        reset_engine_after_speak=not args.keep_engine,
    )
    server = TtsServer((args.host, args.port), TtsRequestHandler, state)
    server_thread = threading.Thread(target=server.serve_forever, name="pyttsx3-http-server", daemon=True)
    server_thread.start()

    print(
        f"pyttsx3 TTS service listening on http://{args.host}:{args.port} "
        f"(rate={args.rate}, volume={state.volume}, dry_run={state.dry_run}, "
        f"reset_engine_after_speak={state.reset_engine_after_speak})",
        flush=True,
    )
    if pyttsx3 is None:
        print("pyttsx3 is not installed. Install with: python -m pip install -r backend/voice/requirements.txt", file=sys.stderr)

    try:
        # Keep pyttsx3/SAPI on the process main thread. On Windows, running
        # SAPI from a background worker can report success without audible output.
        state.run_forever()
    except KeyboardInterrupt:
        print("\nStopping pyttsx3 TTS service.", flush=True)
    finally:
        state.stop()
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

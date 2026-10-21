"""Voice service readiness checks without using speakers or the SAPI engine."""

import io
import math
import struct
import threading
import unittest
import wave
from unittest.mock import Mock, patch

import pyttsx3_tts_service as tts


class CallbackEngine:
    """A silent engine double that uses the real service callback wiring."""

    def __init__(self, outcome="success", on_say=None, on_stop=None):
        self.outcome = outcome
        self.on_say = on_say
        self.on_stop = on_stop
        self.callbacks = {}
        self.name = None
        self.say_calls = []
        self.stop_calls = 0

    def setProperty(self, name, value):
        pass

    def connect(self, topic, callback):
        self.callbacks.setdefault(topic, []).append(callback)

    def emit(self, topic, **details):
        for callback in self.callbacks.get(topic, []):
            callback(**details)

    def say(self, text, name):
        self.name = name
        self.say_calls.append((text, name))
        if self.on_say:
            self.on_say(text, name)

    def runAndWait(self):
        if callable(self.outcome):
            self.outcome(self)
        elif isinstance(self.outcome, Exception):
            raise self.outcome
        elif self.outcome == "error":
            self.emit("error", name=self.name, exception=RuntimeError("Synthetic callback failure"))
        elif self.outcome == "incomplete":
            self.emit("finished-utterance", name=self.name, completed=False)
        elif self.outcome == "success":
            self.emit("finished-utterance", name=self.name, completed=True)

    def stop(self):
        self.stop_calls += 1
        if self.on_stop:
            self.on_stop(self)


class VoiceReadinessTests(unittest.TestCase):
    def make_state(self):
        return tts.TtsState(rate=165, volume=1, dedupe_seconds=3600)

    @patch.object(tts, "pyttsx3", object())
    def test_busy_engine_reset_does_not_queue_warmup_behind_speech(self):
        state = self.make_state()
        state.speaking_key = "synthetic-active-speech"
        self.assertIsNone(state.engine)
        result = state.health(init_engine=True)
        self.assertTrue(result["ready"])
        self.assertTrue(result["speaking"])
        self.assertEqual(state.queue.qsize(), 0)

    @patch.object(tts, "pyttsx3", object())
    def test_pending_speech_is_ready_before_worker_initializes_engine(self):
        state = self.make_state()
        state.pending.add("synthetic-pending-speech")
        result = state.health(init_engine=True)
        self.assertTrue(result["ready"])
        self.assertEqual(state.queue.qsize(), 0)

    @patch.object(tts, "pyttsx3", object())
    def test_idle_startup_still_waits_for_worker_initialization(self):
        state = self.make_state()

        def initialize():
            warmup = state.queue.get(timeout=1)
            self.assertTrue(warmup["warm_up"])
            warmup["result"]["success"] = True
            warmup["done_event"].set()
            state.queue.task_done()

        worker = threading.Thread(target=initialize)
        worker.start()
        result = state.warm_up(timeout_seconds=1)
        worker.join(timeout=1)
        self.assertTrue(result["success"])
        self.assertFalse(worker.is_alive())


class IntegratedChimeTests(unittest.TestCase):
    def make_state(self, **options):
        return tts.TtsState(rate=165, volume=1, dedupe_seconds=3600, **options)

    def run_worker(self, state):
        state.queue.put(None)
        # These tests never initialize COM or a real speech engine.
        with patch.object(state, "_initialize_audio_thread"), patch.object(state, "_uninitialize_audio_thread"):
            state.run_forever()

    @patch.object(tts, "pyttsx3", object())
    def test_only_explicit_json_true_requests_chime(self):
        for index, payload in enumerate(({}, {"play_chime": False}, {"play_chime": "true"},
                                         {"play_chime": 1}, {"play_chime": None}, {"play_chime": True})):
            state = self.make_state()
            result = state.enqueue({"key": f"synthetic-{index}", "text": "Synthetic announcement", **payload})
            self.assertTrue(result["queued"])
            self.assertEqual(state.queue.get_nowait()["play_chime"], payload.get("play_chime") is True)

    def test_wav_preserves_slow_descending_bell_and_fade(self):
        with wave.open(io.BytesIO(tts.build_chime_wav()), "rb") as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 44100))
            self.assertEqual(wav.getnframes(), 89082)  # 20ms + 800ms + 1200ms
            samples = struct.unpack("<" + "h" * wav.getnframes(), wav.readframes(wav.getnframes()))
        self.assertTrue(all(value == 0 for value in samples[:882]))

        def amplitude(frequency, start, duration=0.1):
            first, count = round(start * 44100), round(duration * 44100)
            section = samples[first:first + count]
            sine = sum(value * math.sin(2 * math.pi * frequency * index / 44100)
                       for index, value in enumerate(section))
            cosine = sum(value * math.cos(2 * math.pi * frequency * index / 44100)
                         for index, value in enumerate(section))
            return math.hypot(sine, cosine) / count

        # The first note is A5; after the second onset it descends to E5.
        self.assertGreater(amplitude(880, 0.04), amplitude(660, 0.04) * 20)
        self.assertGreater(amplitude(660, 0.84), amplitude(880, 0.84) * 20)
        self.assertGreater(amplitude(880, 0.04), amplitude(880, 0.6) * 20)
        self.assertGreater(amplitude(660, 0.84), amplitude(660, 1.6) * 20)
        self.assertLess(max(abs(value) for value in samples), round(0.36 * 32767))
        self.assertLess(max(abs(value) for value in samples[-441:]), 5)

    @patch.object(tts, "pyttsx3", object())
    def test_deduplicated_worker_keeps_bell_then_speech_in_request_order(self):
        state = self.make_state()
        events = []
        for key in ("synthetic-one", "synthetic-two"):
            result = state.enqueue({"key": key, "text": key, "play_chime": True})
            self.assertTrue(result["queued"])
        self.assertTrue(state.enqueue({"key": "synthetic-one", "text": "duplicate", "play_chime": True})["duplicate"])
        with patch.object(state, "_play_chime", side_effect=lambda key: events.append(("bell", key))), \
                patch.object(state, "_speak", side_effect=lambda text, key: events.append(("speech", key))):
            self.run_worker(state)
        self.assertEqual(events, [("bell", "synthetic-one"), ("speech", "synthetic-one"),
                                  ("bell", "synthetic-two"), ("speech", "synthetic-two")])
        self.assertTrue(state.enqueue({"key": "synthetic-two", "text": "duplicate", "play_chime": True})["duplicate"])
        self.assertEqual(state.pending, set())

    def test_bell_is_synchronous_once_across_sapi_retry(self):
        state = self.make_state()
        events = []
        fake_winsound = Mock(SND_MEMORY=4, SND_NODEFAULT=2)
        fake_winsound.PlaySound.side_effect = lambda data, flags: events.append(("bell", flags))
        engines = [CallbackEngine(outcome, on_say=lambda text, name: events.append(("speech", name)))
                   for outcome in (RuntimeError("synthetic SAPI retry"), "success")]
        with patch.object(tts, "pyttsx3", Mock(init=Mock(side_effect=engines))), \
                patch.object(tts, "winsound", fake_winsound), \
                patch.object(state, "_minimum_expected_duration_ms", return_value=0), \
                patch.object(tts.time, "sleep"):
            state.enqueue({"key": "synthetic-retry", "text": "Synthetic", "play_chime": True})
            self.run_worker(state)
        self.assertEqual(events, [("bell", 6), ("speech", "tts-1-1"), ("speech", "tts-2-2")])
        self.assertEqual(fake_winsound.PlaySound.call_args.args[0][:4], b"RIFF")
        self.assertEqual([engine.stop_calls for engine in engines], [1, 1])
        self.assertIn("synthetic-retry", state.seen)

    @patch.object(tts, "pyttsx3", object())
    def test_chime_failure_does_not_suppress_speech_or_mark_voice_failed(self):
        state = self.make_state()
        fake_winsound = Mock(SND_MEMORY=4, SND_NODEFAULT=2)
        fake_winsound.PlaySound.side_effect = RuntimeError("synthetic missing sound device")
        state.enqueue({"key": "synthetic-chime-failure", "text": "Synthetic", "play_chime": True})
        with patch.object(tts, "winsound", fake_winsound), patch.object(state, "_speak") as speak:
            self.run_worker(state)
            health = state.health()
        speak.assert_called_once_with("Synthetic", key="synthetic-chime-failure")
        self.assertIsNone(health["last_error"])
        self.assertEqual(health["last_chime_error"], "synthetic missing sound device")
        self.assertTrue(health["chime_supported"])
        self.assertIn("synthetic-chime-failure", state.seen)

    @patch.object(tts, "pyttsx3", object())
    def test_dry_run_and_legacy_payload_never_play_audio(self):
        for dry_run, payload in ((True, {"play_chime": True}), (False, {})):
            state = self.make_state(dry_run=dry_run)
            state.enqueue({"key": "synthetic-silent", "text": "Synthetic", **payload})
            with patch.object(tts, "winsound") as fake_winsound, patch.object(tts.time, "sleep"):
                if dry_run:
                    self.run_worker(state)
                else:
                    with patch.object(state, "_speak"):
                        self.run_worker(state)
            fake_winsound.PlaySound.assert_not_called()

    @patch.object(tts, "pyttsx3", object())
    @patch.object(tts, "winsound", None)
    def test_unsupported_chime_reports_capability_and_still_speaks(self):
        state = self.make_state()
        state.enqueue({"key": "synthetic-no-windows", "text": "Synthetic", "play_chime": True})
        with patch.object(state, "_speak") as speak:
            self.run_worker(state)
        speak.assert_called_once()
        self.assertFalse(state.health()["chime_supported"])
        self.assertIsNone(state.health()["chime_engine"])
        self.assertIsNone(state.last_error)


class PendingAnnouncementTests(unittest.TestCase):
    def make_state(self):
        return tts.TtsState(rate=165, volume=1, dedupe_seconds=3600)

    def join_pending_work(self, state, *, fail=False):
        """Hold real worker progress while a duplicate HTTP caller waits."""
        key = "synthetic-refresh"
        state.enqueue({"key": key, "text": "Synthetic announcement", "play_chime": True})
        item = state.pending_items[key]
        started, release, waiting = (threading.Event() for _ in range(3))
        responses, audio = [], []
        original_wait = item["done_event"].wait

        def speak(text, key):
            audio.append(("speech", key))
            started.set()
            if not release.wait(2):
                raise RuntimeError("Synthetic test barrier timed out")
            if fail:
                raise RuntimeError("Synthetic playback failed")

        def wait_for_original(timeout):
            waiting.set()
            return original_wait(timeout)

        state.queue.put(None)
        worker = threading.Thread(target=state.run_forever, daemon=True)
        caller = threading.Thread(target=lambda: responses.append(state.enqueue({
            "key": key, "text": "Duplicate announcement", "play_chime": True, "wait": True,
        })), daemon=True)
        with patch.object(state, "_initialize_audio_thread"), patch.object(state, "_uninitialize_audio_thread"), \
                patch.object(state, "_play_chime", side_effect=lambda key: audio.append(("bell", key))), \
                patch.object(state, "_speak", side_effect=speak), \
                patch.object(item["done_event"], "wait", side_effect=wait_for_original):
            worker.start()
            try:
                self.assertTrue(started.wait(1))
                caller.start()
                self.assertTrue(waiting.wait(1), "Duplicate must wait on the original item")
                self.assertEqual(responses, [], "Pending work must not be reported as successful")
                acquired = state.lock.acquire(blocking=False)
                if acquired:
                    state.lock.release()
                self.assertTrue(acquired, "Duplicate must release the lock before waiting")
            finally:
                release.set()
                if caller.ident is not None:
                    caller.join(timeout=2)
                worker.join(timeout=2)
            self.assertFalse(caller.is_alive())
            self.assertFalse(worker.is_alive())
        self.assertEqual(len(responses), 1)
        self.assertEqual(state.pending, set())
        self.assertEqual(state.pending_items, {})
        return responses[0], audio

    @patch.object(tts, "pyttsx3", object())
    def test_waiting_duplicate_joins_nonwaiting_original_without_replaying_audio(self):
        state = self.make_state()
        result, audio = self.join_pending_work(state)
        self.assertEqual(result, {"success": True, "queued": False, "duplicate": True,
                                  "key": "synthetic-refresh"})
        self.assertEqual(audio, [("bell", "synthetic-refresh"), ("speech", "synthetic-refresh")])
        self.assertIn("synthetic-refresh", state.seen)
        # A completed key still returns immediately, including wait=true.
        self.assertEqual(state.enqueue({"key": "synthetic-refresh", "text": "Again", "wait": True}), result)
        self.assertEqual(state.queue.qsize(), 0)

    @patch.object(tts, "pyttsx3", object())
    def test_pending_failure_reaches_duplicate_and_allows_retry(self):
        state = self.make_state()
        result, audio = self.join_pending_work(state, fail=True)
        self.assertFalse(result["success"])
        self.assertTrue(result["duplicate"])
        self.assertEqual(result["error"], "Synthetic playback failed")
        self.assertEqual(audio, [("bell", "synthetic-refresh"), ("speech", "synthetic-refresh")])
        self.assertNotIn("synthetic-refresh", state.seen)

        retry = state.enqueue({"key": "synthetic-refresh", "text": "Retry", "play_chime": True})
        self.assertTrue(retry["queued"])
        self.assertFalse(retry["duplicate"])
        state.queue.put(None)
        with patch.object(state, "_initialize_audio_thread"), patch.object(state, "_uninitialize_audio_thread"), \
                patch.object(state, "_play_chime") as chime, patch.object(state, "_speak") as speak:
            state.run_forever()
        chime.assert_called_once_with(key="synthetic-refresh")
        speak.assert_called_once_with("Retry", key="synthetic-refresh")
        self.assertIn("synthetic-refresh", state.seen)

    @patch.object(tts, "pyttsx3", object())
    def test_pending_timeout_does_not_remove_or_duplicate_original_work(self):
        state = self.make_state()
        state.enqueue({"key": "synthetic-timeout", "text": "Original", "play_chime": True})
        item = state.pending_items["synthetic-timeout"]
        with patch.object(item["done_event"], "wait", return_value=False) as wait:
            result = state.enqueue({"key": "synthetic-timeout", "text": "Resubmitted",
                                    "wait": True, "timeout_seconds": 12})
        wait.assert_called_once_with(12)
        self.assertFalse(result["success"])
        self.assertTrue(result["duplicate"])
        self.assertIn("Timed out", result["error"])
        self.assertEqual(state.queue.qsize(), 1)
        self.assertIs(state.pending_items["synthetic-timeout"], item)
        self.assertNotIn("synthetic-timeout", state.seen)
        self.assertFalse(item["done_event"].is_set())

    @patch.object(tts, "pyttsx3", object())
    def test_nonwaiting_pending_duplicate_keeps_immediate_compatibility(self):
        state = self.make_state()
        state.enqueue({"key": "synthetic-nonwaiting", "text": "Original"})
        item = state.pending_items["synthetic-nonwaiting"]
        with patch.object(item["done_event"], "wait", side_effect=AssertionError("Must not wait")):
            result = state.enqueue({"key": "synthetic-nonwaiting", "text": "Resubmitted", "wait": False})
        self.assertEqual(result, {"success": True, "queued": False, "duplicate": True,
                                  "key": "synthetic-nonwaiting"})
        self.assertEqual(state.queue.qsize(), 1)


class CallbackOutcomeTests(unittest.TestCase):
    def run_callback_work(self, outcomes, **options):
        state = tts.TtsState(rate=165, volume=1, dedupe_seconds=3600, **options)
        engines = [outcome if isinstance(outcome, CallbackEngine) else CallbackEngine(outcome)
                   for outcome in outcomes]
        with patch.object(tts, "pyttsx3", Mock(init=Mock(side_effect=engines))), \
                patch.object(state, "_initialize_audio_thread"), patch.object(state, "_uninitialize_audio_thread"), \
                patch.object(state, "_play_chime") as chime, \
                patch.object(state, "_minimum_expected_duration_ms", return_value=0), \
                patch.object(tts.time, "sleep"), patch.object(tts, "log_event"):
            state.enqueue({"key": "synthetic-callback", "text": "Synthetic announcement", "play_chime": True})
            item = state.pending_items["synthetic-callback"]
            state.queue.put(None)
            state.run_forever()
        self.assertTrue(item["done_event"].is_set())
        self.assertEqual(state.pending, set())
        self.assertEqual(state.pending_items, {})
        self.assertIsNone(state.active_utterance)
        chime.assert_called_once_with(key="synthetic-callback")
        self.assertEqual([engine.stop_calls for engine in engines], [1] * len(engines))
        return state, item["result"], engines

    def test_positive_completion_is_required_before_marking_seen(self):
        state, result, engines = self.run_callback_work(["success"])
        self.assertEqual(result, {"success": True})
        self.assertIn("synthetic-callback", state.seen)
        self.assertIsNone(state.last_error)
        self.assertEqual(engines[0].say_calls, [("Synthetic announcement", "tts-1-1")])

    def test_callback_error_or_incomplete_completion_fails_after_retry(self):
        for outcome, message in (("error", "Synthetic callback failure"), ("incomplete", "incomplete utterance")):
            with self.subTest(outcome=outcome):
                state, result, engines = self.run_callback_work([outcome, outcome])
                self.assertIn(message, result["error"])
                self.assertNotIn("success", result)
                self.assertEqual(state.seen, {})
                self.assertEqual(state.last_error, result["error"])
                self.assertNotEqual(engines[0].name, engines[1].name)

    def test_missing_completion_cannot_be_acknowledged(self):
        state, result, _ = self.run_callback_work(["missing", "missing"])
        self.assertIn("did not confirm successful utterance completion", result["error"])
        self.assertEqual(state.seen, {})

    def test_later_positive_completion_does_not_erase_callback_failure(self):
        for failure in ("error", "incomplete"):
            with self.subTest(failure=failure):
                def fail_then_finish(engine):
                    if failure == "error":
                        engine.emit("error", name=engine.name, exception=RuntimeError("Synthetic callback failure"))
                    else:
                        engine.emit("finished-utterance", name=engine.name, completed=False)
                    engine.emit("finished-utterance", name=engine.name, completed=True)

                state, result, _ = self.run_callback_work([fail_then_finish, fail_then_finish])
                self.assertIn("error", result)
                self.assertEqual(state.seen, {})

    def test_positive_completion_still_requires_minimum_playback_duration(self):
        state = tts.TtsState(rate=165, volume=1, dedupe_seconds=3600)
        engines = [CallbackEngine(), CallbackEngine()]
        with patch.object(tts, "pyttsx3", Mock(init=Mock(side_effect=engines))), \
                patch.object(tts.time, "monotonic", side_effect=[1.0, 1.0, 2.0, 2.0]), \
                patch.object(tts.time, "sleep"), patch.object(tts, "log_event"):
            with self.assertRaisesRegex(RuntimeError, "returned too quickly"):
                state._speak("Synthetic announcement", key="synthetic-fast")
        self.assertIsNone(state.active_utterance)

    def test_callback_failure_retries_with_a_fresh_engine_and_single_bell(self):
        state, result, engines = self.run_callback_work(["error", "success"])
        self.assertEqual(result, {"success": True})
        self.assertIn("synthetic-callback", state.seen)
        self.assertEqual(state.engine_generation, 2)
        self.assertEqual([engine.name for engine in engines], ["tts-1-1", "tts-2-2"])

    def test_failed_key_can_be_resubmitted_and_succeed(self):
        state, failed, _ = self.run_callback_work(["incomplete", "error"])
        self.assertIn("error", failed)
        engine = CallbackEngine()
        with patch.object(tts, "pyttsx3", Mock(init=Mock(return_value=engine))), \
                patch.object(state, "_initialize_audio_thread"), patch.object(state, "_uninitialize_audio_thread"), \
                patch.object(state, "_play_chime") as chime, \
                patch.object(state, "_minimum_expected_duration_ms", return_value=0), \
                patch.object(tts, "log_event"):
            retry = state.enqueue({"key": "synthetic-callback", "text": "Retry", "play_chime": True})
            retry_item = state.pending_items["synthetic-callback"]
            self.assertTrue(retry["queued"])
            self.assertFalse(retry["duplicate"])
            state.queue.put(None)
            state.run_forever()
            completed = state.enqueue({"key": "synthetic-callback", "text": "Duplicate", "wait": True})
        chime.assert_called_once_with(key="synthetic-callback")
        self.assertEqual(retry_item["result"], {"success": True})
        self.assertTrue(completed["success"])
        self.assertTrue(completed["duplicate"])
        self.assertIsNone(state.last_error)

    def test_stale_generation_and_token_failures_do_not_poison_new_attempt(self):
        old = CallbackEngine("error")

        def finish_new_attempt(engine):
            # These have either the current name on an old engine or an old
            # name on the current engine. Neither identifies this attempt.
            old.emit("error", name=engine.name, exception=RuntimeError("Stale generation"))
            old.emit("finished-utterance", name=engine.name, completed=False)
            engine.emit("error", name=old.name, exception=RuntimeError("Stale token"))
            engine.emit("finished-utterance", name=old.name, completed=False)
            engine.emit("finished-utterance", name=engine.name, completed=True)

        state, result, _ = self.run_callback_work([old, finish_new_attempt])
        self.assertEqual(result, {"success": True})
        self.assertIn("synthetic-callback", state.seen)

    def test_stale_positive_completion_cannot_acknowledge_new_attempt(self):
        old = CallbackEngine("error")

        def stale_completion_only(engine):
            old.emit("finished-utterance", name=engine.name, completed=True)
            engine.emit("finished-utterance", name=old.name, completed=True)

        state, result, _ = self.run_callback_work([old, stale_completion_only])
        self.assertIn("did not confirm successful utterance completion", result["error"])
        self.assertEqual(state.seen, {})

    def test_callbacks_from_engine_stop_do_not_change_a_completed_outcome(self):
        def stop_callbacks(engine):
            engine.emit("error", name=engine.name, exception=RuntimeError("Late stop error"))
            engine.emit("finished-utterance", name=engine.name, completed=False)

        state, result, _ = self.run_callback_work([CallbackEngine(on_stop=stop_callbacks)])
        self.assertEqual(result, {"success": True})
        self.assertIsNone(state.last_error)

    def test_keep_engine_uses_unique_tokens_between_announcements(self):
        state = tts.TtsState(rate=165, volume=1, dedupe_seconds=3600, reset_engine_after_speak=False)
        engine = CallbackEngine()
        with patch.object(tts, "pyttsx3", Mock(init=Mock(return_value=engine))), \
                patch.object(state, "_minimum_expected_duration_ms", return_value=0), \
                patch.object(tts, "log_event"):
            state._speak("First", key="same-key")
            first_name = engine.name

            def stale_then_finish(current):
                current.emit("error", name=first_name, exception=RuntimeError("Prior utterance"))
                current.emit("finished-utterance", name=first_name, completed=False)
                current.emit("finished-utterance", name=current.name, completed=True)

            engine.outcome = stale_then_finish
            state._speak("Second", key="same-key")
            self.assertNotEqual(first_name, engine.name)
            self.assertEqual(state.engine_generation, 1)
            state._dispose_engine("test-cleanup")
        self.assertIsNone(state.active_utterance)


class ConcurrentCallbackJoinTests(unittest.TestCase):
    def run_join_wave(self, fail):
        """24 HTTP-equivalent waiters share actual callback-driven playback."""
        count = 24
        key = "synthetic-concurrent-callback"
        state = tts.TtsState(rate=165, volume=1, dedupe_seconds=3600)
        started, release, all_waiting = (threading.Event() for _ in range(3))
        counter_lock = threading.Lock()
        entered = 0
        responses, errors, audio = [], [], []

        def finish_original(engine):
            started.set()
            if not release.wait(10):
                raise RuntimeError("Synthetic callback barrier timed out")
            if fail:
                engine.emit("error", name=engine.name, exception=RuntimeError("Synthetic callback failure"))
            else:
                engine.emit("finished-utterance", name=engine.name, completed=True)

        engines = [CallbackEngine(finish_original, on_say=lambda text, name: audio.append(("speech", name)))]
        if fail:
            engines.append(CallbackEngine("error", on_say=lambda text, name: audio.append(("speech", name))))

        def caller():
            try:
                responses.append(state.enqueue({"key": key, "text": "Refresh duplicate", "wait": True}))
            except BaseException as exc:
                errors.append(exc)

        with patch.object(tts, "pyttsx3", Mock(init=Mock(side_effect=engines))), \
                patch.object(state, "_initialize_audio_thread"), patch.object(state, "_uninitialize_audio_thread"), \
                patch.object(state, "_play_chime", side_effect=lambda key: audio.append(("bell", key))), \
                patch.object(state, "_minimum_expected_duration_ms", return_value=0), \
                patch.object(tts.time, "sleep"), patch.object(tts, "log_event"):
            state.enqueue({"key": key, "text": "Original", "play_chime": True})
            item = state.pending_items[key]
            original_wait = item["done_event"].wait

            def track_wait(timeout):
                nonlocal entered
                with counter_lock:
                    entered += 1
                    if entered == count:
                        all_waiting.set()
                return original_wait(timeout)

            state.queue.put(None)
            worker = threading.Thread(target=state.run_forever, daemon=True)
            callers = [threading.Thread(target=caller, daemon=True) for _ in range(count)]
            with patch.object(item["done_event"], "wait", side_effect=track_wait):
                worker.start()
                try:
                    self.assertTrue(started.wait(5))
                    for thread in callers:
                        thread.start()
                    self.assertTrue(all_waiting.wait(5), "All refresh callers must join the original item")
                    self.assertEqual(responses, [], "Callback outcome is still pending")
                    self.assertEqual(state.queue.qsize(), 1)  # Only the stop sentinel remains.
                    acquired = state.lock.acquire(blocking=False)
                    if acquired:
                        state.lock.release()
                    self.assertTrue(acquired, "Waiting duplicates must release the state lock")
                finally:
                    release.set()
                    for thread in callers:
                        if thread.ident is not None:
                            thread.join(5)
                    worker.join(5)
                self.assertTrue(all(not thread.is_alive() for thread in callers))
                self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(len(responses), count)
        for response in responses:
            self.assertEqual(response["success"], not fail)
            self.assertTrue(response["duplicate"])
            self.assertFalse(response["queued"])
            if fail:
                self.assertIn("Synthetic callback failure", response["error"])
        self.assertEqual(audio[0], ("bell", key))
        self.assertEqual(sum(stage == "bell" for stage, _ in audio), 1)
        self.assertEqual(sum(stage == "speech" for stage, _ in audio), 2 if fail else 1)
        self.assertEqual(state.pending, set())
        self.assertEqual(state.pending_items, {})
        self.assertIsNone(state.active_utterance)
        self.assertEqual(key in state.seen, not fail)

    def test_24_waiters_join_callback_confirmed_success(self):
        for wave in range(3):
            with self.subTest(wave=wave):
                self.run_join_wave(fail=False)

    def test_24_waiters_receive_callback_failure_without_replaying_bell(self):
        for wave in range(3):
            with self.subTest(wave=wave):
                self.run_join_wave(fail=True)


if __name__ == "__main__":
    unittest.main()

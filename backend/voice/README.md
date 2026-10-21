# pyttsx3 Queue Display Voice Service

The [project README](../../README.md#run-the-pyttsx3-voice-announcer-on-windows) contains the complete Windows setup and patient workflow walkthrough. This document provides the voice service commands and troubleshooting details.

## Where to run it

Run this service on the same computer that opens the Queue Display page, from the logged-in Windows desktop session that owns its speakers. Python produces the speech on the computer running this process; running it on the backend computer does not send audio to another display computer.

The normal local service URL is `http://127.0.0.1:8765`. If the application is hosted elsewhere, this address still refers to the computer running the browser. Each display computer needs its own local Python service.

Use a foreground PowerShell terminal for this setup. Apache/XAMPP services, Windows services, and another account's scheduled or remote session may not have access to the intended desktop audio device.

## One-time Windows setup

From the project root, create a local Python 3.13 environment and install the pinned dependencies:

```powershell
py -3.13 --version
py -3.13 -m venv .venv-voice
.\.venv-voice\Scripts\python.exe -m pip install -r backend\voice\requirements.txt
```

Python can be installed from the [official Windows downloads](https://www.python.org/downloads/windows/). If `py` is unavailable but Python is installed, use its full executable path to create the environment:

```powershell
& 'C:\Path\To\Python313\python.exe' -m venv .venv-voice
```

Replace that placeholder with the actual path. Collaborators who already have `uv` can instead use:

```powershell
uv python install 3.13 --no-bin --no-registry
uv venv --python 3.13 --seed .venv-voice
.\.venv-voice\Scripts\python.exe -m pip install -r backend\voice\requirements.txt
```

Directly invoking `.venv-voice\Scripts\python.exe` avoids virtual-environment activation and PowerShell execution-policy changes. The environment is ignored by Git and is recreated locally by each collaborator. After pulling dependency updates, rerun the pip install command.

## Start and verify

Start the service in a terminal and keep it open:

```powershell
.\start-voice.cmd
```

You can also double-click `start-voice.cmd` in the project root. The launcher checks `/health?init=1` and reuses an existing ready `pyttsx3` service only when `dry_run` is `False` and `last_error` is empty. Otherwise it checks the project-local Python dependencies and initializes Windows speech without speaking before starting the service in the current terminal. It does not install dependencies, stop other processes, or configure automatic startup. Launcher and service diagnostics stay in that terminal.

The startup line should include `listening on http://127.0.0.1:8765` and `dry_run=False`. Keep that terminal open; stop the service with `Ctrl+C` there. Backend and frontend startup do not start this separate Python process. Run the launcher again after rebooting or closing its terminal.

The `.cmd` wrapper permits its bundled PowerShell script for that invocation only; it does not change the machine's execution policy. For direct Python startup or custom speech options, use:

```powershell
.\.venv-voice\Scripts\python.exe backend\voice\pyttsx3_tts_service.py
```

In another PowerShell terminal, request engine initialization and inspect the response:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health?init=1' -TimeoutSec 15 |
    Format-List
```

Expected fields:

| Field | Expected value | Meaning |
| --- | --- | --- |
| `engine` | `pyttsx3` | This is the intended voice service. |
| `ready` | `True` | The dependency and requested engine initialization succeeded. |
| `dry_run` | `False` | The service will attempt actual playback. |
| `last_error` | Empty/null | No current engine error was reported. |
| `process_id` | A process ID | Identifies the service instance. |

Health initialization does not prove sound reaches the speakers. Send this synthetic phrase and listen:

```powershell
$voiceTestBody = @{
    key = 'manual-test-' + [guid]::NewGuid().ToString()
    text = 'Voice announcement test. Please proceed to Doctor 1, Room 1.'
    wait = $true
    timeout_seconds = 45
} | ConvertTo-Json

Invoke-RestMethod -Uri 'http://127.0.0.1:8765/speak' -Method Post `
    -ContentType 'application/json' -Body $voiceTestBody -TimeoutSec 60 |
    Format-List
```

Successful playback should return `success: True`, `queued: True`, and `duplicate: False`, and the phrase should be audible on the intended output device. `wait: True` waits for the service's playback attempt to finish. This request goes directly to Python and does not change patient records.

Each test uses a new key. Reusing a successful key produces `duplicate: True` and suppresses playback for the configured deduplication period, one hour by default. To test again, rerun the block that creates `$voiceTestBody`.

## Connect it to the Queue Display

1. Run the application's backend and frontend in separate terminals as described in the [project README](../../README.md#run-the-application).
2. In the Superadmin dashboard, open **System Settings → Announcements**. Set **Voice Announcements** and **Announce Doctor & Room** to **Enabled**, then click **Save Settings**. **Sound Notifications** controls the browser bell separately from Python speech.
3. Open `http://localhost:3000/queue-display` on the computer running Python. When using a remotely hosted frontend, open that application's `/queue-display` URL instead.
4. Confirm the top button reads **Voice Enabled** and the status reports the local service as ready/listening. The display starts enabled by default; if it is paused, click **Voice Disabled** to enable it. The global setting must also allow voice announcements.
5. Keep the page open before the doctor accepts a new patient. Registration creates a waiting patient; Frontdesk **Call Now** assigns the eligible patient to the doctor without announcing. **Doctor Accept** creates the announcement event.
6. For an already accepted current patient, use **Re-Call** to create another announcement event. Each event has a unique key; repeated display polling does not create another announcement for the same key.

The announcement reads the queue number character by character, includes the patient name, and ends with the assigned doctor and room when that setting is enabled. The existing acceptance and re-call workflow supplies these details; do not send direct patient speech requests from Frontdesk.

On initial page load, events older than the page opening time are seeded as historical rather than spoken. Opening or reloading the display after acceptance does not automatically replay that old event. Use **Re-Call** or a new development patient acceptance for a manual workflow test. Keep backend and display clocks synchronized for this timestamp check.

## Change the local voice port

If port 8765 is already used by another application, choose another local port, for example 8766:

```powershell
.\start-voice.cmd -Port 8766
```

The launcher also accepts `-BindHost` (default `127.0.0.1`) and honors `PYTTSX3_TTS_HOST` and `PYTTSX3_TTS_PORT` from the current terminal when those arguments are omitted. It does not read either application's `.env` file; the frontend URL must match the chosen service address.

Add or update this line in the frontend's local environment file, `frontend/.env`:

```dotenv
NEXT_PUBLIC_PYTTSX3_TTS_URL=http://127.0.0.1:8766
```

Restart the development frontend and reload the Queue Display. For a production frontend, rebuild and restart it; the public environment value is included in the browser bundle. Verify `/health?init=1` and `/speak` at the new port too.

Do not put this variable only in `backend/.env`: it configures browser requests. Keep the service bound to loopback for the normal same-computer setup.

## Optional speech settings

Command-line options override the service's environment defaults:

```powershell
.\.venv-voice\Scripts\python.exe backend\voice\pyttsx3_tts_service.py --rate 165 --volume 1.0
```

| Option | Default | Purpose |
| --- | --- | --- |
| `--host` | `127.0.0.1` | HTTP bind address. |
| `--port` | `8765` | HTTP port. |
| `--rate` | `165` | Speech rate passed to pyttsx3. |
| `--volume` | `1.0` | Volume, clamped to the range 0–1. |
| `--dedupe-seconds` | `3600` | How long successful event keys remain suppressed. |
| `--dry-run` | Off | Logs speech without playing audio; use only for non-audio testing. |
| `--keep-engine` | Off | Reuses the engine; the default resets it between announcements to reduce silent playback issues. |

Environment equivalents are `PYTTSX3_TTS_HOST`, `PYTTSX3_TTS_PORT`, `PYTTSX3_TTS_RATE`, `PYTTSX3_TTS_VOLUME`, `PYTTSX3_TTS_DEDUPE_SECONDS`, `PYTTSX3_TTS_DRY_RUN`, and `PYTTSX3_TTS_KEEP_ENGINE`. The Python script reads the process environment; it does not load `backend/.env` automatically.

## Troubleshooting

### Python, pip, or npm is not recognized

Use the installed executable's full path, or reopen PowerShell after installing it. For Python, create `.venv-voice` with the intended interpreter, then use `.\.venv-voice\Scripts\python.exe -m pip` so dependencies go into that same environment. For Node's usual Windows installation, use `& 'C:\Program Files\nodejs\npm.cmd' --prefix backend run dev` or the equivalent frontend command.

### PowerShell says scripts are disabled

Use the direct environment Python commands above instead of `Activate.ps1`. Use `npm.cmd` instead of `npm` if PowerShell selects `npm.ps1`. These commands do not require changing the machine's execution policy.

### The voice service cannot be reached

Confirm its terminal is still running and the address and port match the frontend's configured URL. Run `/health?init=1` directly. If PowerShell succeeds but the browser cannot connect, inspect the Queue Display's developer console and Network panel for the failed request. Check any browser permission prompt or policy that blocks access to the local service.

### Port 8765 is already in use

Check the listener without stopping an unknown process:

```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen |
    Select-Object LocalAddress, LocalPort, OwningProcess
```

If it is an existing voice service, use its terminal's `Ctrl+C` before restarting. If another application owns it, use a different port and update the frontend URL as described above.

If the voice service was started in the background and has no visible terminal, identify it from the health response:

```powershell
$voiceHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health'
Get-CimInstance Win32_Process |
    Where-Object { $_.ProcessId -eq $voiceHealth.process_id } |
    Select-Object ProcessId, CommandLine
```

Confirm that the command line runs `pyttsx3_tts_service.py` before stopping that service:

```powershell
Stop-Process -Id $voiceHealth.process_id
```

Then start it in a foreground terminal with the normal command. If the current service works, leave it running and avoid starting a second instance on the same port.

### Health says `ready: False` or shows an error

Rerun the pinned requirements install through the environment's Python. Read `last_error` and the service terminal for an engine or Windows speech error. Restart the foreground service and retry `/health?init=1`. Windows speech uses SAPI; dependency or engine initialization problems must be resolved on the display computer.

### Health succeeds but nothing is heard

Check that `dry_run` is `False`; `--dry-run` or `PYTTSX3_TTS_DRY_RUN=1` intentionally disables actual speech even if health says ready. Stop the service, remove that dry-run setting, and restart it.

Verify the Windows output device, speaker power, volume, and Volume Mixer for the Python process. Confirm the service runs in the same logged-in desktop session, then repeat the unique-key synthetic `/speak` test. A bell without speech means browser audio works, but does not verify Python's audio output. Speech without a bell can occur when Sound Notifications is disabled or browser audio has not been unlocked; toggling voice off/on provides a user click for the bell.

If the terminal reports `runAndWait returned too quickly` or a playback error, the service detected an apparently silent/failed attempt. Keep the default engine reset behavior, restart the service, and repeat the synthetic test before testing patients. A JSON success response is useful evidence about the service, but listening remains necessary to verify the physical speakers.

### A patient appears but is not announced

Confirm both the global **Voice Announcements** setting and this display's **Voice Enabled** control. A serving patient who is still awaiting **Accept** does not yet have an acceptance announcement. If acceptance happened before the page opened, use the existing **Re-Call** action. Keep the page open while creating the fresh event and allow for the configured **Announcement Gap**.

### An announcement repeats or is missing after restarting

Do not reuse a synthetic test's event key unless testing deduplication. The service stores deduplication keys in memory, while the backend persists acceptance/re-call events and the display tracks events for its page lifetime. Restarting services/pages changes those in-memory sets; the display's initial history seed prevents routine playback of old events.

Run only the intended display instances for a set of speakers. Multiple displays and service instances on different computers can each speak the same backend event. For diagnostics, observe one Queue Display connected to one voice service.

## Diagnostic logs

The Python terminal prints structured stages such as `health`, `speak-request`, `enqueue-ok`, `speak-run-start`, `speak-run-ok`, and `queue-item-error`. The Queue Display browser console uses the prefix `[QueueDisplay TTS]` and the backend logs acceptance/re-call events. Match the `key` across the browser and Python logs to trace one announcement.

Browser TTS diagnostics are enabled by default. To disable them, set `NEXT_PUBLIC_TTS_DEBUG=0` in the frontend environment, then restart development or rebuild/restart production. Logs may contain patient details; use synthetic test output when sharing setup diagnostics.

# Cabadbaran City Health Office and Family Planning Center Queuing System

A web-based queuing system with weighted-priority scheduling and doctor acceptance voice announcements for the Cabadbaran City Health Office and Family Planning Center.

The project root is the official Git working copy. Use `backend/` and `frontend/` here for development. The earlier temporary checkout has been merged into these folders.

## Run the application

Configure `backend/.env` and `frontend/.env` using their `.env.example` files if needed. Existing local environment files and runtime queue settings are retained.

For Phase 2, apply the [versioned consultation migration](backend/scripts/20261010-phase2-consultation-lifecycle.sql) to an approved development Supabase project before using Start/Complete Consultation. Follow the [migration and verification guide](docs/phase2-consultation.md). The application does not apply schema changes automatically; production application requires explicit approval.

Phase A adds authenticated doctor presence separately from counter enablement and patient occupancy. Apply its [versioned session migration](backend/scripts/20261012-phase-a-auth-presence.sql) before deploying this code, then sign in again. See the [presence and rollout guide](docs/phase-a-doctor-presence.md) for heartbeat/logout behavior, access controls and verification. Live migration application is a separate rollout step; the local implementation does not apply it automatically.

Phase 2.1 protects Requeue/Undo from stale requests that could erase completed consultation history. See its [revision and recovery migration](backend/scripts/20261012-phase21-stale-recovery.sql) and [Phase 2.1 guide](docs/phase21-stale-recovery.md). Phase 2.2 adds the [versioned waiting-only Undo entry point](backend/scripts/20261014-phase22-undo-waiting.sql); use the [development rollout guide](docs/phase22-audit-corrections.md) and [read-only installation checks](backend/scripts/20261015-phase22-verify.sql) before enabling that workflow in an approved environment. Pulling this code does not apply migrations.

Install dependencies when setting up a new checkout:

```sh
npm --prefix backend ci
npm --prefix frontend ci
```

Run these commands in separate terminals from the project root:

```sh
npm --prefix backend run dev
npm --prefix frontend run dev
```

The default backend port is 4000 and the frontend port is 3000. Restart existing servers after integrating backend changes.

If your terminal is already inside `backend/`, run `npm.cmd run dev` there; use `--prefix backend` only from the project root. Stop a running backend with Ctrl+C, answer Y if Windows asks to terminate the batch job, then start it again after saving `.env` changes. Keep one backend watcher running. A duplicate instance reports `EADDRINUSE` and exits without seeding counters.

Backend startup seeds only missing doctor counters. Existing counter IDs, availability and active patient assignments are preserved across restarts; Supabase consultations can resume using their saved start time and the existing acceptance file.

The backend loads `backend/.env` regardless of its launch directory. When Supabase is configured, a database outage reports an error and subsequent requests retry the database; it does not replace saved patients with an empty local queue. Temporary in-memory development storage is used only when Supabase is unconfigured. The backend requires a private JWT signing secret; see below.

To test Frontdesk, Doctor and Superadmin simultaneously, use different browsers or separate browser profiles. Tabs in one browser profile share a login and update their displayed account together. An expired login returns protected pages to sign-in instead of leaving them polling with an invalid token.

### JWT signing secret

`JWT_SECRET` in `backend/.env` signs every staff login token. There is no built-in fallback: the backend stops at startup with `Invalid JWT_SECRET in backend/.env` when the value is missing, empty, contains whitespace, is a sample or placeholder such as `change-me` or `default_secret`, is shorter than 43 characters, or is obviously repetitive. These checks catch mistakes; they cannot prove a value is random, so always use a cryptographic generator. The error never prints the configured value.

Generate a value in Windows PowerShell from the project root. It is copied to the clipboard and is not displayed:

```powershell
$bytes = New-Object byte[] 48; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose(); [Convert]::ToBase64String($bytes) | Set-Clipboard; Remove-Variable bytes, rng
```

Open `backend/.env` in an editor, replace only the value after `JWT_SECRET=` with the clipboard contents, save, then clear the clipboard (`Set-Clipboard -Value ' '`). Never commit `backend/.env` or share the value; each environment uses its own secret. Restart the backend afterwards. Tokens signed with the previous secret stop working, so every open browser returns to sign-in and staff log in again with their usual accounts; patients, consultations and accounts are unaffected.

## Run the pyttsx3 voice announcer on Windows

Run the Python voice service on the **same computer and logged-in Windows desktop session as the Queue Display and its speakers**. The backend starts the voice service automatically on Windows and keeps it running, so normally only the backend and frontend need terminals. The Python worker plays the selected slow, descending ding-dong and then the spoken announcement. **Sound Notifications** controls the chime; turning it off still allows speech. The bell needs no browser activation click and stays ready across registration polls and display reloads while the updated local service is running and announcements are enabled.

### 1. Open PowerShell in the project root

For this checkout:

```powershell
Set-Location 'C:\Users\Edrian\Documents\Capstone 1\queue-management-system-CITY_HEALTH-main'
```

Collaborators should substitute their own checkout path. All commands below run from the project root.

### 2. Prepare the Python environment once per computer

Use an installed Python 3.13 interpreter for the project-local environment:

```powershell
py -3.13 --version
py -3.13 -m venv .venv-voice
.\.venv-voice\Scripts\python.exe -m pip install -r backend\voice\requirements.txt
```

If the launcher or Python 3.13 is unavailable, install Python 3.13 from the [official Python Windows downloads](https://www.python.org/downloads/windows/), then reopen PowerShell. If Python is installed but the launcher is unavailable, substitute its full path for the environment-creation command:

```powershell
& 'C:\Path\To\Python313\python.exe' -m venv .venv-voice
```

The full path above is a placeholder. If you already use `uv`, this is an alternative to the Python launcher commands:

```powershell
uv python install 3.13 --no-bin --no-registry
uv venv --python 3.13 --seed .venv-voice
.\.venv-voice\Scripts\python.exe -m pip install -r backend\voice\requirements.txt
```

If `uv` is not on PATH, invoke its installed executable by its full path. This setup calls the environment's Python directly, so `Activate.ps1` and changes to PowerShell's execution policy are unnecessary. `.venv-voice` is local to each computer and must not be committed. Repeat the pip install command when `requirements.txt` changes.

### 3. Start all three services

Keep three PowerShell terminals open in the project root:

**Terminal 1 — voice service:**

```powershell
.\start-voice.cmd
```

You can also double-click `start-voice.cmd` in the project folder. It reuses an already healthy local service, or checks the local Python environment and Windows speech engine before starting one. Expect a startup line containing `listening on http://127.0.0.1:8765` and `dry_run=False`. Leave the service terminal running. The launcher reports setup errors without installing dependencies or stopping an existing process.

**Terminal 2 — backend:**

```powershell
npm.cmd --prefix backend run dev
```

**Terminal 3 — frontend:**

```powershell
npm.cmd --prefix frontend run dev
```

Install the Node dependencies from the application setup section first if this is a new checkout. `npm.cmd` avoids the `npm.ps1` execution-policy error that can occur in PowerShell. If Node is installed without being on PATH, use `& 'C:\Program Files\nodejs\npm.cmd'` instead of `npm.cmd`.

### 4. Check the voice service and speakers

Use an additional PowerShell terminal for these checks:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health?init=1' -TimeoutSec 15 |
    Format-List
```

Confirm `ready: True`, `dry_run: False`, `chime_supported: True`, and empty/null `last_error` and `last_chime_error`. If `chime_supported` is missing, restart the existing Python service with the updated script. Then send a synthetic announcement with a new key:

```powershell
$voiceTestBody = @{
    key = 'manual-test-' + [guid]::NewGuid().ToString()
    text = 'Voice announcement test. Please proceed to Doctor 1, Room 1.'
    play_chime = $true
    wait = $true
    timeout_seconds = 45
} | ConvertTo-Json

Invoke-RestMethod -Uri 'http://127.0.0.1:8765/speak' -Method Post `
    -ContentType 'application/json' -Body $voiceTestBody -TimeoutSec 60 |
    Format-List
```

Expect `success: True`, `queued: True`, `duplicate: False`, **and listen for the descending bell followed by the phrase on the intended speakers**. A successful health response alone does not verify audible playback. This direct voice test does not register, call, accept, complete, or otherwise change a patient.

### 5. Enable announcements and test the existing workflow

1. In the Superadmin dashboard, open **System Settings → Announcements**. Enable **Voice Announcements** and **Announce Doctor & Room**, then click **Save Settings**. Enable **Sound Notifications** for the local Python bell before speech.
2. Open [Queue Display](http://localhost:3000/queue-display) on the display computer. It normally starts with **Voice Enabled**. If it says **Voice Disabled**, click that button to resume the intentionally paused announcer. Check that the status reports the local pyttsx3 service as ready/listening. There is no separate **Enable Bell** step.
3. Keep the display open before generating the new event. Register a development patient, ensure the assigned doctor is online, and use Frontdesk **Call Now** for the eligible next patient.
4. Confirm the patient appears under the correct doctor. Frontdesk calling does not announce the patient; the doctor must click **Accept**.
5. Listen for the accepted patient's queue number, name, doctor, and room. The queue number is read character by character, for example `G P 0 0 1`. Repeated display polls should not repeat that same event.
6. While the accepted patient remains current, use the doctor's existing **Re-Call** to generate a fresh announcement event. Completion and cancellation keep their existing behavior.

With Phase 2 installed, click **Start Consultation** after acceptance, then **Complete Consultation** when service actually ends. These actions do not announce again. Only the assigned doctor can start or complete; Frontdesk and Superadmin monitor the consultation phase.

On a fresh visit without a recovery checkpoint, earlier events are treated as historical. A short same-tab reload with a valid two-minute checkpoint can recover eligible unfinished Accept/Re-Call events while suppressing completed announcements. Missing, blocked or expired checkpoints retain fresh-visit behavior. Authorized staff can use **Re-Call** when an additional announcement is needed for a current accepted patient. Keep the display and backend clocks synchronized; see the [recovery limits](backend/voice/README.md#connect-it-to-the-queue-display). A positive API/driver result does not prove physical audibility, and restarting both the page and Python process during delivery does not guarantee exactly-once sound.

### 6. Stop and restart

Press `Ctrl+C` in each service terminal to stop it. On later days, the environment setup and installs are normally unnecessary: start the three commands from step 3, check the speakers, then open the Queue Display.

If a voice service is already running, stop that instance before starting its replacement. After updating the Python script, restart it and confirm `chime_supported: True`; an older running process does not acquire the new bell behavior from a browser refresh. The detailed guide explains how to identify and stop a background service when a restart is needed.

For another voice port, failed health checks, silent playback, and diagnostic logs, see the [detailed voice service guide](backend/voice/README.md). A custom `NEXT_PUBLIC_PYTTSX3_TTS_URL` belongs in the frontend environment; restart the development frontend after changing it, or rebuild and restart a production frontend.

## Validate changes

```sh
npm --prefix backend test
npm --prefix frontend test
npm --prefix frontend run build -- --webpack
```

The workflow tests use isolated database/storage doubles and a mocked local pyttsx3 HTTP service. Live Supabase behavior and audible playback from the local Python service require separate manual verification.

The Phase 2 guide also documents the optional local PostgreSQL suite, which executes the actual migration and backend RPC payloads, and the single-process test command for restricted Windows environments. Existing service-time Analytics uses valid actual consultation start/end durations and excludes cancelled, No-show and unstarted historical records.

The Windows voice setup above and [backend/voice/README.md](backend/voice/README.md) describe the separate audible playback check on the computer that opens the Queue Display.

## Workflow and documentation

Registration creates a waiting patient. Calling selects the next patient by the existing weighted score and registration time within the assigned doctor's queue. The backend assigns the doctor and marks the patient serving; doctor acceptance drives the existing voice announcement. Start Consultation records the actual PostgreSQL start time while the patient stays serving. Complete Consultation saves the end and releases the doctor transactionally. Completed records expose duration derived from these timestamps; historical or cancelled records without a valid completed consultation have no duration.

- [Phase 2 lifecycle, Supabase migration, and test guide](docs/phase2-consultation.md)
- [Official palette reference](docs/design/cho-palette.html)
- [Design reference notes](docs/design/README.md)

Runtime acceptance state is stored in `backend/data/awaiting-accept.json` and is ignored by Git. `backend/data/queue-settings.json` retains the current project's settings.

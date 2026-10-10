# pyttsx3 Queue Display Voice Service

Run this service on the same computer that opens the Queue Display page. `pyttsx3`
plays audio on the machine running Python, so this keeps announcements on the
display computer's speakers.

```powershell
python -m pip install -r backend\voice\requirements.txt
python backend\voice\pyttsx3_tts_service.py
```

Start it from the logged-in desktop session that owns the Queue Display
speakers. Do not run it as an Apache/XAMPP service, Windows service, scheduled
task in another account, or remote session if that session cannot access the
intended audio output.

The Queue Display browser posts announcements to `http://127.0.0.1:8765` by
default. To use another local address, set `NEXT_PUBLIC_PYTTSX3_TTS_URL` before
building or starting the frontend.

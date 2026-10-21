[CmdletBinding()]
param(
    [Alias('Host')]
    [string]$BindHost = '127.0.0.1',
    [ValidateRange(1, 65535)]
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$pythonPath = Join-Path $projectRoot '.venv-voice\Scripts\python.exe'
$servicePath = Join-Path $PSScriptRoot 'pyttsx3_tts_service.py'

try {
    if ((-not $PSBoundParameters.ContainsKey('Port')) -and $env:PYTTSX3_TTS_PORT) {
        $configuredPort = 0
        if ((-not [int]::TryParse($env:PYTTSX3_TTS_PORT, [ref]$configuredPort)) -or
            $configuredPort -lt 1 -or $configuredPort -gt 65535) {
            throw 'PYTTSX3_TTS_PORT must be a number between 1 and 65535.'
        }
        $Port = $configuredPort
    }
    if ((-not $PSBoundParameters.ContainsKey('BindHost')) -and $env:PYTTSX3_TTS_HOST) {
        $BindHost = $env:PYTTSX3_TTS_HOST
    }
    $healthHost = switch ($BindHost) {
        '0.0.0.0' { '127.0.0.1' }
        '::' { '[::1]' }
        default { if ($BindHost.Contains(':')) { "[$BindHost]" } else { $BindHost } }
    }
    $serviceUrl = "http://${healthHost}:$Port"
    Write-Host "Checking Queue Display voice service at $serviceUrl ..."
    $health = $null
    $healthReceived = $false
    try {
        $health = Invoke-RestMethod -Uri "$serviceUrl/health?init=1" -TimeoutSec 12
        $healthReceived = $true
    }
    catch {
        # An absent server is expected before the first launch. Never stop an
        # existing listener or assume an unresponsive service is safe to replace.
    }

    if ($healthReceived) {
        if ($health.engine -cne 'pyttsx3') {
            throw "Another service answered on port $Port. Choose a different port; no process was stopped."
        }
        if (($health.dry_run -isnot [bool]) -or $health.dry_run) {
            throw 'The existing voice service has dry-run enabled or an invalid health response. Stop it from its own terminal and restart without --dry-run or PYTTSX3_TTS_DRY_RUN=1.'
        }
        if (($health.ready -isnot [bool]) -or (-not $health.ready) -or
            (-not [string]::IsNullOrWhiteSpace([string]$health.last_error))) {
            throw "The existing voice service is not ready. Reported error: $($health.last_error). Check its terminal and backend\voice\README.md."
        }

        Write-Host "Voice service is ready (pyttsx3, dry_run=False, PID $($health.process_id)). Reusing it." -ForegroundColor Green
        Write-Host 'Keep its existing terminal running. This launcher did not start a second copy.'
        Write-Host 'Refresh Queue Display, then use Re-Call for an already accepted patient.'
        exit 0
    }

    $portInUse = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -eq $Port }
    if ($portInUse) {
        throw "Port $Port is in use, but the voice health check failed. Check the existing application's terminal, or use -Port with an unused port. No process was stopped."
    }

    if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
        throw @'
The project voice Python environment is missing. Run these commands from the project root once:
  py -3.13 -m venv .venv-voice
  .\.venv-voice\Scripts\python.exe -m pip install -r backend\voice\requirements.txt
See backend\voice\README.md if Python 3.13 is not installed.
'@
    }

    if ($env:PYTTSX3_TTS_DRY_RUN -and
        @('1', 'true', 'yes', 'on') -contains $env:PYTTSX3_TTS_DRY_RUN.Trim().ToLowerInvariant()) {
        throw 'PYTTSX3_TTS_DRY_RUN disables speech. Remove it from this terminal environment and run the launcher again.'
    }

    Write-Host 'Checking local Python dependencies and Windows speech engine (no speech is played) ...'
    & $pythonPath -c "import pyttsx3, pythoncom; engine = pyttsx3.init(); engine.stop(); print('Windows speech engine initialized.', flush=True)"
    if ($LASTEXITCODE -ne 0) {
        throw @'
The Windows speech check failed. Review the Python error above. If dependencies are missing, run:
  .\.venv-voice\Scripts\python.exe -m pip install -r backend\voice\requirements.txt
Then retry from the logged-in Windows desktop with the Queue Display speakers.
'@
    }

    Write-Host "Starting voice service at $serviceUrl (dry_run=False)." -ForegroundColor Green
    Write-Host 'Keep this terminal open on the Queue Display computer. Press Ctrl+C here to stop it.'
    Write-Host 'Service requests and playback errors appear below. Verify sound using Re-Call on an accepted patient.'
    # Invoke Python directly in this terminal. The service keeps SAPI playback on
    # its process main thread in the current logged-in desktop session.
    & $pythonPath -u $servicePath --host $BindHost --port $Port
    if ($LASTEXITCODE -ne 0) {
        throw "The voice service exited with code $LASTEXITCODE. Review the service error above."
    }
    exit 0
}
catch {
    Write-Host "Voice launcher: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

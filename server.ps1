<#
    AE1 - Angel's Egg 1
    Launcher.

    Resolves a real Python interpreter, bootstraps an isolated venv, starts the
    server, and opens Brave in incognito.

    Incognito is deliberate, not incidental: it wipes localStorage on close,
    which structurally enforces "the filesystem is the only source of truth"
    (DESIGN.md, Principle 1). A feature that depends on the browser durably
    holding state cannot be built, because the browser doesn't.

    Usage:
        .\server.ps1                 launch normally
        .\server.ps1 -Port 8080      use a different port
        .\server.ps1 -NoBrowser      start the server only
        .\server.ps1 -Rebuild        discard and rebuild the venv
#>

[CmdletBinding()]
param(
    [int]    $Port = 8000,
    [switch] $NoBrowser,
    [switch] $Rebuild
)

$ErrorActionPreference = 'Stop'

$Root        = $PSScriptRoot
$VenvDir     = Join-Path $Root '.venv'
$VenvPython  = Join-Path $VenvDir 'Scripts\python.exe'
$Requirements= Join-Path $Root 'requirements.txt'
$ServerPy    = Join-Path $Root 'server.py'

function Write-Step ($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }
function Write-Ok   ($msg) { Write-Host "  $msg" -ForegroundColor DarkGreen }
function Write-Warn ($msg) { Write-Host "  $msg" -ForegroundColor DarkYellow }

function Resolve-Python {
    # The `py` launcher is the only reliable entry point on Windows.
    #
    # Bare `python` frequently resolves to the WindowsApps stub, which opens the
    # Microsoft Store rather than executing anything. It reports success and does
    # nothing, so it must be filtered explicitly rather than trusted.
    $py = Get-Command 'py' -ErrorAction SilentlyContinue
    if ($py) {
        return [pscustomobject]@{ Exe = $py.Source; Prefix = @('-3') }
    }

    foreach ($name in @('python3', 'python')) {
        $found = Get-Command $name -All -ErrorAction SilentlyContinue
        foreach ($c in $found) {
            if ($c.Source -and ($c.Source -notlike '*\WindowsApps\*')) {
                return [pscustomobject]@{ Exe = $c.Source; Prefix = @() }
            }
        }
    }

    return $null
}

function Resolve-Brave {
    $candidates = @(
        (Join-Path $env:ProgramFiles        'BraveSoftware\Brave-Browser\Application\brave.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'BraveSoftware\Brave-Browser\Application\brave.exe'),
        (Join-Path $env:LOCALAPPDATA        'BraveSoftware\Brave-Browser\Application\brave.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    $cmd = Get-Command 'brave' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Test-PortFree ($p) {
    $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    return (-not $conns)
}

Write-Host ''
Write-Host '  AE1 - Angel''s Egg 1' -ForegroundColor White
Write-Host '  ---------------------' -ForegroundColor DarkGray

# --- Python ------------------------------------------------------------------

if ($Rebuild -and (Test-Path $VenvDir)) {
    Write-Step 'Removing existing venv...'
    Remove-Item -Recurse -Force $VenvDir
}

if (-not (Test-Path $VenvPython)) {
    $python = Resolve-Python
    if (-not $python) {
        Write-Host ''
        Write-Host '  No usable Python found.' -ForegroundColor Red
        Write-Host '  Install Python 3.9+ from https://python.org and re-run.' -ForegroundColor Red
        Write-Host '  (A `python` that opens the Microsoft Store is a stub, not an install.)' -ForegroundColor DarkGray
        Write-Host ''
        exit 1
    }

    $versionInfo = & $python.Exe @($python.Prefix + @('--version'))
    Write-Step "Using $versionInfo"
    Write-Step 'Creating venv (first run only)...'
    & $python.Exe @($python.Prefix + @('-m', 'venv', $VenvDir))
    if ($LASTEXITCODE -ne 0) { throw 'venv creation failed.' }

    Write-Step 'Installing dependencies...'
    & $VenvPython -m pip install --quiet --upgrade pip
    if (Test-Path $Requirements) {
        & $VenvPython -m pip install --quiet -r $Requirements
        if ($LASTEXITCODE -ne 0) {
            # Dependencies are optimization-only (DESIGN.md 8.4). The engine is
            # correct without them, so a failed install must not block launch.
            Write-Warn 'Some dependencies failed to install. Continuing.'
            Write-Warn 'Export will skip asset optimization; games still build correctly.'
        }
    }
    Write-Ok 'Environment ready.'
}

# --- Port --------------------------------------------------------------------

if (-not (Test-PortFree $Port)) {
    Write-Host ''
    Write-Host "  Port $Port is already in use." -ForegroundColor Red
    Write-Host "  Another AE1 may be running, or pass -Port <n> to use a different one." -ForegroundColor DarkGray
    Write-Host ''
    exit 1
}

# --- Server ------------------------------------------------------------------

$url = "http://localhost:$Port"

Write-Step "Starting server on $url"

$serverArgs = @($ServerPy, '--port', $Port, '--root', $Root)
$proc = Start-Process -FilePath $VenvPython -ArgumentList $serverArgs `
                      -NoNewWindow -PassThru

# Wait for the listener rather than sleeping a fixed guess.
$ready = $false
foreach ($attempt in 1..50) {
    Start-Sleep -Milliseconds 100
    if (-not (Test-PortFree $Port)) { $ready = $true; break }
    if ($proc.HasExited) { break }
}

if (-not $ready) {
    Write-Host ''
    Write-Host '  Server failed to start.' -ForegroundColor Red
    Write-Host ''
    exit 1
}

Write-Ok "Serving on $url"

# --- Browser -----------------------------------------------------------------

if (-not $NoBrowser) {
    $brave = Resolve-Brave
    if ($brave) {
        Write-Step 'Opening Brave (incognito)...'
        Start-Process -FilePath $brave -ArgumentList @('--incognito', '--new-window', $url) | Out-Null
    }
    else {
        Write-Warn 'Brave not found. Opening your default browser instead.'
        Write-Warn 'Note: outside incognito, AE1 still treats the filesystem as truth.'
        Start-Process $url | Out-Null
    }
}

Write-Host ''
Write-Host '  Ready. Press Ctrl+C to stop.' -ForegroundColor DarkGray
Write-Host ''

try {
    Wait-Process -Id $proc.Id
}
finally {
    if (-not $proc.HasExited) {
        Write-Host ''
        Write-Step 'Stopping server...'
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
}

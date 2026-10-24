# AZITO Hub Installer for Windows (the counterpart of install.sh).
#
# Usage (Windows PowerShell 5.1, as the current user, no administrator rights):
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/wireframeslayout/azito/releases/latest/download/install.ps1 | iex"
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Version <tag>] [-Prefix <dir>] [-Port <n>] [-Yes] [-NoPath] [-NoService]
#   & ([scriptblock]::Create((irm <url of install.ps1>))) -Version v0.12.0 -Port 3010 -Yes    # arguments with the download form
#
# The script is written to run as TEXT (`irm | iex`, a scriptblock) as well as a file. The whole installer is one script block
# that is called at the end of the file: its functions, variables and $ErrorActionPreference stay inside it, so nothing is left in
# the calling session. It never uses `exit` when it is not run as install.ps1 itself (that would end the caller's PowerShell): a
# failure is an error that stops the caller's command (a non-zero exit under -Command / -File) and the caller's session goes on.
# `iex` cannot pass arguments, so every option can also be set by an environment variable AZITO_INSTALL_<OPTION> (VERSION, PREFIX,
# PORT, ZIPPATH, SHA256SUMS; YES, NOPATH, NOSERVICE take 1); an argument wins over the variable.
#
# It installs the hub bundle (azito-hub-<tag>-win32-x64.zip) into <Prefix>\hub\<tag>\ and points <Prefix>\hub\current.txt at it (Windows does not use
# a `current` symlink), creates <Prefix>\hub\.env and <Prefix>\data\, and puts the `azito` command in <Prefix>\bin\.
# Unless -NoService is given, the hub is registered as a Task Scheduler task that starts at your logon (the counterpart of the
# systemd / launchd service of install.sh), and started: `azito start|stop|restart|status` operate it, and its log is <Prefix>\logs\hub.log.
# The bundled misao (the pane server) is installed beside it as its own Task Scheduler task, through `azito misao install`.
#
# The release this file is published with replaces the value of $ReleaseTag below, so the installer downloaded from
# releases/latest/download/ installs exactly that release (one lookup of "latest", made by the download itself). Run from a
# checkout the value is still the placeholder, and "latest" is asked of the GitHub API.

# The body below is deliberately not indented: it is long, and the here-strings need their terminators in column 0.
try {
& {
[CmdletBinding()]
param(
    # Release tag to install (default: the release this file was published with; from a checkout, the latest release).
    [string]$Version = '',
    # Installation prefix (default: %USERPROFILE%\.azito).
    [string]$Prefix = '',
    # Port the hub listens on. Written to a new hub\.env as PORT and in AZITO_ALLOWED_ORIGINS (an existing hub\.env is never touched).
    [ValidateRange(1, 65535)]
    [int]$Port = 3001,
    # Use this local azito-hub-<tag>-win32-x64.zip instead of downloading one (offline installs, CI).
    [string]$ZipPath = '',
    # SHA256SUMS file to check -ZipPath against (a download is always checked against the release's SHA256SUMS).
    [string]$Sha256Sums = '',
    # Skip the confirmation prompt.
    [switch]$Yes,
    # Do not add <Prefix>\bin to the user's PATH.
    [switch]$NoPath,
    # Do not register the Task Scheduler tasks (the hub's and misao's). Run the hub in the foreground with `azito run`, or register it later with `azito service install`.
    [switch]$NoService
)

# These assignments are local to this script block: the caller's preferences are not changed.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Repo = 'wireframeslayout/azito'
# Replaced by release.yml with the tag the release is published under. Anything else (this placeholder) means "not published".
$ReleaseTag = '__AZITO_RELEASE_TAG__'

# An option that was not given as an argument may come from AZITO_INSTALL_<OPTION>: `irm | iex` has no way to pass arguments.
foreach ($option in @('Version', 'Prefix', 'Port', 'ZipPath', 'Sha256Sums')) {
    if ($PSBoundParameters.ContainsKey($option)) { continue }
    $fromEnvironment = [Environment]::GetEnvironmentVariable('AZITO_INSTALL_' + $option.ToUpperInvariant())
    if ($fromEnvironment) { Set-Variable -Name $option -Value $fromEnvironment }
}
foreach ($option in @('Yes', 'NoPath', 'NoService')) {
    if ($PSBoundParameters.ContainsKey($option)) { continue }
    if ([Environment]::GetEnvironmentVariable('AZITO_INSTALL_' + $option.ToUpperInvariant()) -eq '1') { Set-Variable -Name $option -Value ([switch]$true) }
}
$PortRequested = $PSBoundParameters.ContainsKey('Port') -or [bool][Environment]::GetEnvironmentVariable('AZITO_INSTALL_PORT')

# The `azito` command. It lives in <prefix>\bin, so the prefix is the folder above the script: a custom -Prefix works
# without an environment variable. Everything is quoted so a profile folder with spaces or parentheses survives.
$CliWrapper = @'
@echo off
setlocal EnableExtensions DisableDelayedExpansion
for %%I in ("%~dp0..") do set "AZITO_ROOT=%%~fI"
if not exist "%AZITO_ROOT%\hub\current.txt" goto :notinstalled
rem current.txt must be exactly a version such as v0.12.0: a line that is anything else (a BOM, UTF-16, spaces) is refused here.
findstr /r /x /v /c:"v*[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*[-+.0-9A-Za-z]*" "%AZITO_ROOT%\hub\current.txt" >nul
if not errorlevel 1 goto :badpointer
set "AZITO_VER="
set /p AZITO_VER=<"%AZITO_ROOT%\hub\current.txt"
if not defined AZITO_VER goto :badpointer
set "AZITO_HUB=%AZITO_ROOT%\hub\%AZITO_VER%"
if not exist "%AZITO_HUB%\node.exe" goto :missinghub
set "AZITO_CMD=%~1"
if /i "%AZITO_CMD%"=="start" goto :start
if /i "%AZITO_CMD%"=="stop" goto :stop
if /i "%AZITO_CMD%"=="restart" goto :restart
if /i "%AZITO_CMD%"=="status" goto :status
if /i "%AZITO_CMD%"=="run" goto :run
if /i "%AZITO_CMD%"=="token" goto :forward
if /i "%AZITO_CMD%"=="misao" goto :forward
if /i "%AZITO_CMD%"=="service" goto :forward
if /i "%AZITO_CMD%"=="version" goto :version
if not defined AZITO_CMD goto :usage
setlocal EnableDelayedExpansion
echo Unknown command: !AZITO_CMD! 1>&2
echo. 1>&2
echo Usage: azito {start^|stop^|restart^|status^|run^|token show^|token rotate^|misao status^|service status^|version} 1>&2
exit /b 1

:forward
"%AZITO_HUB%\node.exe" "%AZITO_HUB%\azito-hub.cjs" %*
exit /b %ERRORLEVEL%

:start
"%AZITO_HUB%\node.exe" "%AZITO_HUB%\azito-hub.cjs" service start
exit /b %ERRORLEVEL%

:stop
"%AZITO_HUB%\node.exe" "%AZITO_HUB%\azito-hub.cjs" service stop
exit /b %ERRORLEVEL%

:restart
"%AZITO_HUB%\node.exe" "%AZITO_HUB%\azito-hub.cjs" service restart
exit /b %ERRORLEVEL%

:status
"%AZITO_HUB%\node.exe" "%AZITO_HUB%\azito-hub.cjs" service status
exit /b %ERRORLEVEL%

:run
rem The hub in this window (Ctrl+C stops it), not as the Task Scheduler task: for a first look, or an install made with -NoService.
if not exist "%AZITO_HUB%\run.ps1" goto :missinghub
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%AZITO_HUB%\run.ps1"
exit /b %ERRORLEVEL%

:version
echo current: %AZITO_VER%
<nul set /p "=bundle:  "
"%AZITO_HUB%\node.exe" "%AZITO_HUB%\azito-hub.cjs" --version
exit /b %ERRORLEVEL%

:usage
echo Usage: azito {start^|stop^|restart^|status^|run^|token show^|token rotate^|misao status^|service status^|version}
exit /b 0

:notinstalled
rem The messages below print paths through delayed expansion, so & ^ ( ) in a path are not run as cmd syntax.
setlocal EnableDelayedExpansion
echo ERROR: AZITO not found at !AZITO_ROOT!\hub\current.txt 1>&2
echo Run install.ps1 first. 1>&2
exit /b 1

:badpointer
setlocal EnableDelayedExpansion
echo ERROR: !AZITO_ROOT!\hub\current.txt must hold one version such as v0.12.0 (ASCII, no BOM, no spaces). 1>&2
echo Write it from PowerShell with [System.IO.File]::WriteAllText(path, 'v0.12.0'), or delete it and run install.ps1 again. 1>&2
exit /b 1

:missinghub
setlocal EnableDelayedExpansion
echo ERROR: the hub folder !AZITO_HUB! is incomplete (node.exe or run.ps1 is missing) or current.txt names a version that is not installed. 1>&2
echo Check !AZITO_ROOT!\hub\current.txt, or delete it and run install.ps1 again. 1>&2
exit /b 1
'@

function Test-ReleaseVersion([string]$Value) {
    # The tag becomes a folder name and part of a file name: allow only what a release tag looks like.
    return $Value -match '^v?[0-9]+\.[0-9]+\.[0-9]+([-+.][0-9A-Za-z.-]+)?$'
}

function Get-ExpectedSha256([string]$SumsText, [string]$FileName) {
    foreach ($line in ($SumsText -split "`r?`n")) {
        if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $FileName) { return $Matches[1].ToLowerInvariant() }
    }
    throw "$FileName is not listed in SHA256SUMS"
}

function Assert-ZipSha256([string]$Zip, [string]$SumsText) {
    $name = Split-Path -Leaf $Zip
    $expected = Get-ExpectedSha256 $SumsText $name
    $actual = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) {
        throw "SHA256 mismatch for $name`n  Expected: $expected`n  Got:      $actual"
    }
    Write-Host 'SHA256 verified.'
}

function Get-HostTar {
    # The OS's own bsdtar reads zip. Never `tar` from PATH: Git for Windows puts a GNU tar there, which cannot.
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { throw "$tar does not exist (Windows 10 version 1803 or later ships it)" }
    return $tar
}

# True when a zip entry name would land outside the folder it is extracted into.
function Test-EscapingEntry([string]$Entry) {
    if ($Entry -match '^[\\/]' -or $Entry -match '^[A-Za-z]:') { return $true }
    foreach ($segment in ($Entry -split '[\\/]')) { if ($segment -eq '..') { return $true } }
    return $false
}

function Expand-HubZip([string]$Zip, [string]$Destination) {
    $tar = Get-HostTar
    $entries = @(& $tar -tf $Zip)
    if ($LASTEXITCODE -ne 0) { throw "could not read $Zip as a zip archive" }
    $bad = @($entries | Where-Object { Test-EscapingEntry $_ })
    if ($bad.Count -gt 0) { throw "the archive has entries outside the install folder (e.g. $($bad[0])); refusing to extract it" }
    New-Item -ItemType Directory -Path $Destination | Out-Null
    & $tar -xf $Zip -C $Destination
    if ($LASTEXITCODE -ne 0) { throw "could not extract $Zip" }
}

# Writes the file through a temporary file in the same folder and then swaps it in, so a reader never sees a half-written pointer.
function Write-TextAtomic([string]$Path, [string]$Text) {
    $tmp = "$Path.tmp"
    [System.IO.File]::WriteAllText($tmp, $Text, (New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        [System.IO.File]::Replace($tmp, $Path, $null)
    } else {
        [System.IO.File]::Move($tmp, $Path)
    }
}

function Find-Tailscale {
    $found = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $root) { continue }
        $candidate = Join-Path $root 'Tailscale\tailscale.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

# The MagicDNS name (no trailing dot) of this host, or $null when Tailscale is not logged in / has no name.
function Get-TailscaleDns([string]$Tailscale) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Tailscale
    $info.Arguments = 'status --self --json'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(15000)) {
        $process.Kill()
        return $null
    }
    if ($process.ExitCode -ne 0) { return $null }
    $self = ($stdout.Result | ConvertFrom-Json).Self
    if ($null -eq $self -or -not $self.DNSName) { return $null }
    return ([string]$self.DNSName).TrimEnd('.')
}

# Tells running programs (Explorer, so terminals opened from the Start menu) that the user environment changed.
function Send-EnvironmentChange {
    try {
        if (-not ('Azito.NativeMethods' -as [type])) {
            Add-Type -Namespace Azito -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
        }
        $result = [UIntPtr]::Zero
        # HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG
        [void][Azito.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
    } catch {
        Write-Warning "The PATH change is saved, but running programs could not be told about it ($($_.Exception.Message)). Sign out and in, or open a terminal from an existing one after restarting Explorer."
    }
}

# Adds $Dir to the user's PATH (HKCU\Environment) unless it is already there. The raw value is edited without expanding
# %VARIABLES% and its registry type is kept, so entries like %USERPROFILE%\bin survive. Returns $true when it changed PATH.
function Add-UserPathEntry([string]$Dir) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if ($null -eq $key) { throw 'could not open HKCU\Environment to update PATH' }
    try {
        $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
        $want = $Dir.TrimEnd('\')
        foreach ($entry in ($raw -split ';')) {
            if ($entry -eq '') { continue }
            if ([Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\') -ieq $want) { return $false }
        }
        if ($raw -eq '') { $updated = $Dir } elseif ($raw.EndsWith(';')) { $updated = $raw + $Dir } else { $updated = $raw + ';' + $Dir }
        $key.SetValue('Path', $updated, $kind)
    } finally {
        $key.Close()
    }
    Send-EnvironmentChange
    return $true
}

function Confirm-Proceed {
    if ($Yes -or [Console]::IsInputRedirected) { return $true }
    $answer = Read-Host 'Proceed with installation? [Y/n]'
    return ($answer -eq '' -or $answer -match '^[Yy]')
}

function Invoke-Node([string]$Node, [string[]]$NodeArgs) {
    & $Node @NodeArgs
    if ($LASTEXITCODE -ne 0) { throw "azito-hub $($NodeArgs[1]) failed (exit code $LASTEXITCODE)" }
}

# The port the hub listens on: PORT in hub\.env (the same file run.ps1 loads), 3001 when it names none.
function Get-HubPort([string]$EnvFile) {
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
        if ($line -match '^\s*PORT\s*=\s*"?(\d+)"?\s*$') { return [int]$Matches[1] }
    }
    return 3001
}

# Starts the registered task and waits for /api/health. A task that cannot be started is an error (the files are installed, so
# the message says what to run after fixing it); a hub that has not answered within a minute is a warning with the log's place,
# like install.sh's "Service started but health check failed".
function Start-InstalledService([string]$Node, [string]$Hub, [string]$Prefix, [string]$HubRoot) {
    Write-Host 'Starting the hub...'
    try {
        Invoke-Node $Node @($Hub, 'service', 'start')
    } catch {
        throw "The hub is installed and the task is registered, but it could not be started: $($_.Exception.Message) Fix the problem above and run: azito start"
    }
    $port = Get-HubPort (Join-Path $HubRoot '.env')
    $url = "http://127.0.0.1:$port/api/health"
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5
            if ($response.StatusCode -eq 200) {
                Write-Host "AZITO is running at http://localhost:$port/"
                return
            }
        } catch {
            # not up yet
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Warning "The task was started but $url did not answer within a minute. Check the log: $Prefix\logs\hub.log (azito status shows the task's state)."
}

function Resolve-Release {
    # Returns the tag to install and, for -ZipPath, the local zip.
    if ($ZipPath -ne '') {
        if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) { throw "-ZipPath does not exist: $ZipPath" }
        if ($Version -ne '') { return $Version }
        if ((Split-Path -Leaf $ZipPath) -match '^azito-hub-(.+)-win32-x64\.zip$') { return $Matches[1] }
        throw '-ZipPath does not look like azito-hub-<tag>-win32-x64.zip; pass -Version as well'
    }
    if ($Version -ne '') { return $Version }
    # The published installer names its own release: the zip and SHA256SUMS then come from that tag, and "latest" is not asked again
    # (a release cut between the download of this file and the download of the zip cannot make the two differ).
    if (Test-ReleaseVersion $ReleaseTag) { return $ReleaseTag }
    Write-Host 'Fetching latest release...'
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'azito-install' }
    if (-not $release.tag_name) { throw 'could not determine the latest version' }
    return [string]$release.tag_name
}

function Invoke-Install {
    if ($PSVersionTable.PSVersion.Major -lt 5) { throw "Windows PowerShell 5.1 or later is required (this is $($PSVersionTable.PSVersion))" }
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'AZITO needs a 64-bit Windows' }
    # TLS 1.2 is not on by default in Windows PowerShell 5.1, and GitHub requires it.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    if ($Prefix -eq '') {
        if (-not $env:USERPROFILE) { throw 'USERPROFILE is not set; pass -Prefix' }
        $Prefix = Join-Path $env:USERPROFILE '.azito'
    }
    $Prefix = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Prefix).TrimEnd('\')
    $hubRoot = Join-Path $Prefix 'hub'
    $pointer = Join-Path $hubRoot 'current.txt'

    # Same as install.sh: an installed hub is updated from the app (or by hand), not by running the installer again.
    if (Test-Path -LiteralPath $pointer -PathType Leaf) {
        $installed = ([System.IO.File]::ReadAllText($pointer)).TrimStart([char]0xFEFF).Trim()
        if (-not (Test-ReleaseVersion $installed)) {
            throw "$pointer does not hold a version such as v0.12.0 (it holds '$installed'). Delete it and run this installer again to repair the install."
        }
        Write-Host "AZITO is already installed at $hubRoot"
        Write-Host "  Version: $installed"
        Write-Host ''
        Write-Host 'This installer only handles first-time setup. To update by hand, extract the new'
        Write-Host "azito-hub-<tag>-win32-x64.zip into $hubRoot\<tag> and write that tag into"
        Write-Host "$pointer. See docs/install-and-update.md ('Windows')."
        return
    }

    # AZITO drives git worktrees on this host, so git must exist (checked before anything is downloaded). It is not installed
    # for you: that changes the machine beyond the install prefix. Tailscale and the agent CLIs are optional.
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
        throw ("git was not found on the PATH, and AZITO needs it (it creates git worktrees for every task).`n" +
            "  Install Git for Windows:  winget install --id Git.Git -e --source winget`n" +
            "  (without winget, download it from https://git-scm.com/download/win)`n" +
            "  Then open a NEW PowerShell window and run this installer again: the PATH of this window does not change when git is installed.")
    }

    $resolved = Resolve-Release
    if (-not (Test-ReleaseVersion $resolved)) { throw "not a release tag: $resolved" }
    $tag = $resolved
    $zipName = "azito-hub-$tag-win32-x64.zip"

    Write-Host ''
    Write-Host '  AZITO Hub Installer'
    Write-Host '  -------------------'
    Write-Host "  Version:      $tag"
    Write-Host '  Platform:     win32-x64'
    Write-Host "  Prefix:       $Prefix"
    Write-Host "  Port:         $Port"
    if ($NoService) {
        Write-Host '  Service:      skip (-NoService; run the hub with `azito run`)'
    } else {
        Write-Host "  Service:      Task Scheduler tasks 'AzitoHub' and 'AzitoMisao' (start at your logon)"
    }
    Write-Host ''

    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        Write-Host 'Note: Node.js not found on this host.'
        Write-Host '  AZITO itself runs on the bundled Node, so the hub will start fine. Host Node.js (v24+) is still needed'
        Write-Host '  for installing the browser runtime (npx) and for supervised worker windows.'
    }
    foreach ($cli in @('claude', 'codex')) {
        if (-not (Get-Command "$cli.exe" -ErrorAction SilentlyContinue) -and -not (Get-Command "$cli.cmd" -ErrorAction SilentlyContinue)) {
            Write-Host "Note: '$cli' CLI not found - required only if you run $cli workers."
        }
    }
    $tailscale = Find-Tailscale
    if (-not $tailscale) {
        Write-Host 'Tailscale is not installed (optional). It lets you reach AZITO from other devices;'
        Write-Host 'without it AZITO only serves 127.0.0.1. See https://tailscale.com/download to add it later.'
    }

    if (-not (Confirm-Proceed)) {
        Write-Host 'Aborted.'
        return
    }

    $work = Join-Path ([System.IO.Path]::GetTempPath()) ('azito-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        # Get the zip and check it before anything is written under the prefix.
        if ($ZipPath -ne '') {
            $zip = (Resolve-Path -LiteralPath $ZipPath).ProviderPath
            if ($Sha256Sums -ne '') {
                Write-Host 'Verifying SHA256...'
                Assert-ZipSha256 $zip ([System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $Sha256Sums).ProviderPath))
            } else {
                Write-Warning "-Sha256Sums was not given, so $zipName is used without a checksum."
            }
        } else {
            $base = "https://github.com/$Repo/releases/download/$tag"
            $zip = Join-Path $work $zipName
            Write-Host "Downloading $zipName..."
            Invoke-WebRequest -UseBasicParsing -Uri "$base/$zipName" -OutFile $zip
            $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS").Content
            if ($sums -is [byte[]]) { $sums = [System.Text.Encoding]::UTF8.GetString($sums) }
            Write-Host 'Verifying SHA256...'
            Assert-ZipSha256 $zip $sums
        }

        New-Item -ItemType Directory -Force -Path $hubRoot | Out-Null
        $installDir = Join-Path $hubRoot $tag
        # No pointer means nothing uses this folder: it is what an interrupted earlier run left behind.
        if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
        $staging = Join-Path $hubRoot ".staging-$tag"
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
        Write-Host "Extracting to $installDir..."
        Expand-HubZip $zip $staging
        Move-Item -LiteralPath $staging -Destination $installDir

        $node = Join-Path $installDir 'node.exe'
        $hub = Join-Path $installDir 'azito-hub.cjs'

        $dns = $null
        if ($tailscale) {
            try { $dns = Get-TailscaleDns $tailscale } catch { Write-Warning "Could not read the Tailscale status: $($_.Exception.Message)" }
        }

        # data\ and hub\.env hold secrets: the hub's own code creates them, so the owner-only access rules come from the
        # one SecretFileGuard instead of being written again here in PowerShell.
        $initArgs = @($hub, 'init-env', '--prefix', $Prefix, '--port', [string]$Port)
        if ($dns) { $initArgs += @('--tailscale-dns', $dns) }
        Invoke-Node $node $initArgs

        # An existing hub\.env is kept as it is, so the port the hub will use is the one it names (the guidance below uses it).
        $hubPort = Get-HubPort (Join-Path $hubRoot '.env')
        if ($PortRequested -and $hubPort -ne $Port) {
            Write-Warning "$hubRoot\.env already exists and is kept: the hub will listen on port $hubPort, not $Port. Edit PORT and AZITO_ALLOWED_ORIGINS there to change it."
        }
        if ($tailscale) {
            Write-Host ''
            if ($dns) {
                Write-Host "Tailscale detected ($dns)."
                Write-Host "  AZITO_PUBLIC_URL will be set to https://$dns"
                Write-Host "  For remote access, run: tailscale serve --bg $hubPort"
            } else {
                Write-Host 'Tailscale detected, but no MagicDNS name was found.'
                Write-Host "  To use AZITO remotely, enable MagicDNS and HTTPS certificates in Tailscale, run: tailscale serve --bg $hubPort,"
                Write-Host "  and set AZITO_PUBLIC_URL=https://<your-magicdns-name> in $hubRoot\.env. Local use works as-is."
            }
        }

        # The token the hub will accept is the one in hub\.env (run.ps1 lets .env override the environment), so a token
        # variable inherited from the calling shell must not decide what is shown here.
        $inheritedToken = $env:AZITO_UI_TOKEN
        Remove-Item Env:\AZITO_UI_TOKEN -ErrorAction SilentlyContinue
        try {
            $token = @(& $node $hub 'token' 'show' | Where-Object { $_ -ne '' })
            $tokenExit = $LASTEXITCODE
        } finally {
            if ($null -ne $inheritedToken) { $env:AZITO_UI_TOKEN = $inheritedToken }
        }
        if ($tokenExit -ne 0 -or $token.Count -eq 0) { throw 'azito-hub token show failed' }

        $bin = Join-Path $Prefix 'bin'
        New-Item -ItemType Directory -Force -Path $bin | Out-Null
        # cmd needs CRLF line endings for its labels to be found reliably.
        $wrapper = ($CliWrapper -replace "`r?`n", "`r`n") + "`r`n"
        [System.IO.File]::WriteAllText((Join-Path $bin 'azito.cmd'), $wrapper, (New-Object System.Text.ASCIIEncoding))
        Write-Host "CLI installed at $bin\azito.cmd"

        if ($NoPath) {
            Write-Host "Skipping the PATH change (-NoPath). Add $bin to your PATH to use azito from any folder."
        } elseif (Add-UserPathEntry $bin) {
            Write-Host "Added $bin to your user PATH. Open a new terminal to use azito."
        } else {
            Write-Host "$bin is already in your user PATH."
        }

        # Register the task before the pointer: a registration that fails leaves no pointer, so running the installer again
        # repairs the install. The task's definition is generated by the hub's own code (TypeScript), never written here, and it
        # reads current.txt each time it starts, so it does not name this version.
        if (-not $NoService) {
            Write-Host 'Registering the Task Scheduler task...'
            $installArgs = @($hub, 'service', 'install')
            # -Yes also lets the install replace a task that another install of this user registered (the command refuses without it).
            if ($Yes) { $installArgs += '--yes' }
            Invoke-Node $node $installArgs

            # misao (the pane server) is its own service, separate from the hub: stopping it closes every pane, so a hub update or
            # restart never touches it. Like install.sh, the bundled CLI unpacks it into <Prefix>\misao\<version>\, registers the task
            # 'AzitoMisao', starts it and writes MISAO_SOCKET (the named pipe) into hub\.env, which the hub reads when it starts below.
            # A failure is a warning: the hub is installed either way, and `azito misao install` repeats the step.
            Write-Host 'Installing the misao service...'
            try {
                Invoke-Node $node @($hub, 'misao', 'install', '--prefix', $Prefix)
            } catch {
                Write-Warning "The misao service could not be installed (see the error above): $($_.Exception.Message)"
                Write-Host '  AZITO is installed, but its panes need misao. Fix the problem and run: azito misao install'
            }
        }

        # The pointer is written last, after every step that can fail: it is what marks the install as complete, so a run
        # that stopped earlier (a version folder but no current.txt) is repaired by running the installer again.
        Write-TextAtomic $pointer "$tag`r`n"
        Write-Host "Current version: $tag ($pointer)"

        Write-Host ''
        Write-Host "  UI Token (save this): $($token[-1])"
        Write-Host '  Use it to authenticate in the browser. To show it again: azito token show'
        Write-Host ''
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }

    if (-not $NoService) { Start-InstalledService $node $hub $Prefix $hubRoot }

    Write-Host ''
    Write-Host 'Installation complete!'
    Write-Host ''
    if ($NoService) {
        Write-Host '  The hub is not registered as a service (-NoService).'
        Write-Host '  Run:      azito run     (in this window; stop it with Ctrl+C)'
        Write-Host '  Register: azito service install, then azito start (and azito misao install for the panes)'
    } else {
        Write-Host '  The hub runs as the Task Scheduler task AzitoHub: it starts when you log on and restarts when it fails.'
        Write-Host '  Its panes run on misao, the task AzitoMisao: azito misao status (a hub update or restart does not stop it).'
        Write-Host '  Start:   azito start     (stop: azito stop, restart: azito restart, state: azito status)'
        Write-Host "  Log:     $Prefix\logs\hub.log"
    }
    Write-Host '  Token:   azito token show'
    Write-Host '  Version: azito version'
}

Invoke-Install
} @args
} catch {
    # Only the file install.ps1 itself may `exit`: for `irm | iex` or a script block $PSCommandPath is the caller's, and ending it
    # would close the caller's PowerShell. There the error is thrown, which stops the caller's command and fails -Command with 1.
    if ($PSCommandPath -and [System.IO.Path]::GetFileName($PSCommandPath) -ieq 'install.ps1') {
        [Console]::Error.WriteLine("ERROR: $($_.Exception.Message)")
        exit 1
    }
    throw "AZITO install failed: $($_.Exception.Message)"
}

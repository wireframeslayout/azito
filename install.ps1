# AZITO Hub Installer for Windows (the counterpart of install.sh).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Version <tag>] [-Prefix <dir>] [-Yes] [-NoPath]
#
# Runs under Windows PowerShell 5.1 as the current user (no administrator rights needed). It installs the hub bundle
# (azito-hub-<tag>-win32-x64.zip) into <Prefix>\hub\<tag>\ and points <Prefix>\hub\current.txt at it (Windows does not use
# a `current` symlink), creates <Prefix>\hub\.env and <Prefix>\data\, and puts the `azito` command in <Prefix>\bin\.
# The hub is not installed as a resident service yet: start it with `azito start`.
[CmdletBinding()]
param(
    # Release tag to install (default: the latest release).
    [string]$Version = '',
    # Installation prefix (default: %USERPROFILE%\.azito).
    [string]$Prefix = '',
    # Use this local azito-hub-<tag>-win32-x64.zip instead of downloading one (offline installs, CI).
    [string]$ZipPath = '',
    # SHA256SUMS file to check -ZipPath against (a download is always checked against the release's SHA256SUMS).
    [string]$Sha256Sums = '',
    # Skip the confirmation prompt.
    [switch]$Yes,
    # Do not add <Prefix>\bin to the user's PATH.
    [switch]$NoPath,
    # Accepted for parity with install.sh. The hub is not registered as a service yet, so this is always the behaviour.
    [switch]$NoService
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:Repo = 'wireframeslayout/azito'

# The `azito` command. It lives in <prefix>\bin, so the prefix is the folder above the script: a custom -Prefix works
# without an environment variable. Everything is quoted so a profile folder with spaces or parentheses survives.
$script:CliWrapper = @'
@echo off
setlocal EnableExtensions DisableDelayedExpansion
for %%I in ("%~dp0..") do set "AZITO_ROOT=%%~fI"
if not exist "%AZITO_ROOT%\hub\current.txt" goto :notinstalled
set "AZITO_VER="
set /p AZITO_VER=<"%AZITO_ROOT%\hub\current.txt"
if not defined AZITO_VER goto :badpointer
set "AZITO_HUB=%AZITO_ROOT%\hub\%AZITO_VER%"
if not exist "%AZITO_HUB%\node.exe" goto :missinghub
set "AZITO_CMD=%~1"
if /i "%AZITO_CMD%"=="start" goto :start
if /i "%AZITO_CMD%"=="stop" goto :stop
if /i "%AZITO_CMD%"=="status" goto :status
if /i "%AZITO_CMD%"=="token" goto :forward
if /i "%AZITO_CMD%"=="misao" goto :forward
if /i "%AZITO_CMD%"=="service" goto :forward
if /i "%AZITO_CMD%"=="version" goto :version
if not defined AZITO_CMD goto :usage
echo Unknown command: %AZITO_CMD% 1>&2
echo. 1>&2
echo Usage: azito {start^|stop^|status^|token show^|token rotate^|misao status^|service status^|version} 1>&2
exit /b 1

:forward
"%AZITO_HUB%\node.exe" "%AZITO_HUB%\azito-hub.cjs" %*
exit /b %ERRORLEVEL%

:start
if not exist "%AZITO_HUB%\run.ps1" goto :missinghub
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%AZITO_HUB%\run.ps1"
exit /b %ERRORLEVEL%

:stop
echo azito stop: the hub is not registered as a resident service on Windows yet (planned, see issue #380), so there is nothing to stop. 1>&2
echo A hub started with "azito start" runs in the foreground: stop it with Ctrl+C or by closing its window. 1>&2
exit /b 1

:status
echo azito status: the hub is not registered as a resident service on Windows yet (planned, see issue #380), so there is no status to show. 1>&2
exit /b 1

:version
echo current: %AZITO_VER%
<nul set /p "=bundle:  "
"%AZITO_HUB%\node.exe" "%AZITO_HUB%\azito-hub.cjs" --version
exit /b %ERRORLEVEL%

:usage
echo Usage: azito {start^|stop^|status^|token show^|token rotate^|misao status^|service status^|version}
exit /b 0

:notinstalled
echo ERROR: AZITO not found at %AZITO_ROOT%\hub\current.txt 1>&2
echo Run install.ps1 first. 1>&2
exit /b 1

:badpointer
echo ERROR: %AZITO_ROOT%\hub\current.txt is empty. 1>&2
exit /b 1

:missinghub
echo ERROR: the hub folder %AZITO_HUB% is incomplete (node.exe or run.ps1 is missing). Re-run install.ps1. 1>&2
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

function Resolve-Release {
    # Returns the tag to install and, for -ZipPath, the local zip.
    if ($ZipPath -ne '') {
        if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) { throw "-ZipPath does not exist: $ZipPath" }
        if ($Version -ne '') { return $Version }
        if ((Split-Path -Leaf $ZipPath) -match '^azito-hub-(.+)-win32-x64\.zip$') { return $Matches[1] }
        throw '-ZipPath does not look like azito-hub-<tag>-win32-x64.zip; pass -Version as well'
    }
    if ($Version -ne '') { return $Version }
    Write-Host 'Fetching latest release...'
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$($script:Repo)/releases/latest" -Headers @{ 'User-Agent' = 'azito-install' }
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
        $installed = (Get-Content -LiteralPath $pointer -TotalCount 1).Trim()
        Write-Host "AZITO is already installed at $hubRoot"
        Write-Host "  Version: $installed"
        Write-Host ''
        Write-Host 'This installer only handles first-time setup. To update by hand, extract the new'
        Write-Host "azito-hub-<tag>-win32-x64.zip into $hubRoot\<tag> and write that tag into"
        Write-Host "$pointer. See docs/install-and-update.md ('Windows')."
        return
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
    Write-Host '  Service:      none (start it with `azito start`)'
    Write-Host ''

    # AZITO drives git worktrees on this host, so git must exist. Tailscale and the agent CLIs are optional.
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
        throw 'git is required (AZITO drives git worktrees on this host). Install it (for example: winget install Git.Git) and run this installer again.'
    }
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
            $base = "https://github.com/$($script:Repo)/releases/download/$tag"
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
            Write-Host ''
            if ($dns) {
                Write-Host "Tailscale detected ($dns)."
                Write-Host "  AZITO_PUBLIC_URL will be set to https://$dns"
                Write-Host '  For remote access, run: tailscale serve --bg 3001'
            } else {
                Write-Host 'Tailscale detected, but no MagicDNS name was found.'
                Write-Host '  To use AZITO remotely, enable MagicDNS and HTTPS certificates in Tailscale, run `tailscale serve --bg 3001`,'
                Write-Host "  and set AZITO_PUBLIC_URL=https://<your-magicdns-name> in $hubRoot\.env. Local use works as-is."
            }
        }

        # data\ and hub\.env hold secrets: the hub's own code creates them, so the owner-only access rules come from the
        # one SecretFileGuard instead of being written again here in PowerShell.
        $initArgs = @($hub, 'init-env', '--prefix', $Prefix)
        if ($dns) { $initArgs += @('--tailscale-dns', $dns) }
        Invoke-Node $node $initArgs

        # The pointer is written last: it is what marks the install as complete.
        Write-TextAtomic $pointer "$tag`r`n"
        Write-Host "Current version: $tag ($pointer)"

        $token = @(& $node $hub 'token' 'show' | Where-Object { $_ -ne '' })
        if ($LASTEXITCODE -ne 0 -or $token.Count -eq 0) { throw 'azito-hub token show failed' }
        Write-Host ''
        Write-Host "  UI Token (save this): $($token[-1])"
        Write-Host '  Use it to authenticate in the browser. To show it again: azito token show'
        Write-Host ''

        $bin = Join-Path $Prefix 'bin'
        New-Item -ItemType Directory -Force -Path $bin | Out-Null
        # cmd needs CRLF line endings for its labels to be found reliably.
        $wrapper = ($script:CliWrapper -replace "`r?`n", "`r`n") + "`r`n"
        [System.IO.File]::WriteAllText((Join-Path $bin 'azito.cmd'), $wrapper, (New-Object System.Text.ASCIIEncoding))
        Write-Host "CLI installed at $bin\azito.cmd"

        if ($NoPath) {
            Write-Host "Skipping the PATH change (-NoPath). Add $bin to your PATH to use azito from any folder."
        } elseif (Add-UserPathEntry $bin) {
            Write-Host "Added $bin to your user PATH. Open a new terminal to use azito."
        } else {
            Write-Host "$bin is already in your user PATH."
        }
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Host ''
    Write-Host 'Installation complete!'
    Write-Host ''
    Write-Host '  The hub is not registered as a resident service on Windows yet, so it only runs while you keep it open.'
    Write-Host '  Start:   azito start     (runs in this window; stop it with Ctrl+C)'
    Write-Host '  Token:   azito token show'
    Write-Host '  Version: azito version'
}

# Dot-sourcing this file (the CI test does, to call the functions above) must not install anything.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-Install
    } catch {
        [Console]::Error.WriteLine("ERROR: $($_.Exception.Message)")
        exit 1
    }
}

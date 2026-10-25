# AZITO hub launcher for Windows (the bundle's run.ps1; run-hub.sh is its Unix counterpart).
# Runs under Windows PowerShell 5.1, never asks a question (a scheduled task may start it), runs the hub in the
# foreground and exits with the hub's exit code.
#
# -Service -LogFile <file> -FollowPid <pid> -FollowStart <FileTime> is how the Task Scheduler task starts it (see modules/system/windowsHubService.ts):
# the hub's stdout and stderr are appended to <file> (a task has nowhere to send them), and the hub is told which conhost.exe the task runs
# under so that it ends when that process is gone (the Task Scheduler's "End" ends only that conhost.exe, never the hub below it). The
# launcher names that process by id AND start time, and this script checks it is still running right before it starts the hub: a hub that
# nothing follows would outlive an End and meet the next one on the port, so with the process gone (or not named) no hub is started.
param(
    [switch]$Service,
    [string]$LogFile = '',
    [int]$FollowPid = 0,
    [long]$FollowStart = 0
)
$ErrorActionPreference = 'Stop'
if ($Service -and $LogFile -eq '') { throw '-Service needs -LogFile <file>' }
if ($Service -and ($FollowPid -le 0 -or $FollowStart -le 0)) { throw '-Service needs -FollowPid <pid> and -FollowStart <FileTime> of the conhost.exe the task runs under' }

$bundle = $PSScriptRoot

# Load .env: the stable file beside the versioned bundle directories (hub\.env) wins, the bundle's own is the fallback
# (the same order as run-hub.sh and resolveServerEnvPath). The parsing matches readEnvValue: KEY=value per line, '#'
# comments, no escaping, one pair of matching quotes stripped.
function Import-EnvFile([string]$File) {
    foreach ($line in [System.IO.File]::ReadAllLines($File)) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $eq = $trimmed.IndexOf('=')
        if ($eq -lt 1) { continue }
        $key = $trimmed.Substring(0, $eq).Trim()
        if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
        $value = $trimmed.Substring($eq + 1).Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
}

$envFile = Join-Path (Split-Path -Parent $bundle) '.env'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { $envFile = Join-Path $bundle '.env' }
if (Test-Path -LiteralPath $envFile -PathType Leaf) { Import-EnvFile $envFile }

# UTF-8 for the console and for what the hub prints. Setting [Console]::OutputEncoding / InputEncoding changes the code page of
# the console this process is attached to, which outlives the process, so the previous ones are put back when the hub ends.
# A process without a console (a scheduled task) has none to set: that is reported and the hub still starts.
$restoreOutput = $null
$restoreInput = $null
try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $previousOutput = [Console]::OutputEncoding
    $previousInput = [Console]::InputEncoding
    [Console]::OutputEncoding = $utf8
    $restoreOutput = $previousOutput
    [Console]::InputEncoding = $utf8
    $restoreInput = $previousInput
    $OutputEncoding = $utf8
} catch {
    [Console]::Error.WriteLine("run.ps1: could not switch the console to UTF-8: $($_.Exception.Message)")
}

# Host tool PATH. A scheduled task starts with a PATH that lacks per-user tool locations, and the hub shells out to
# host tools (git, node / npx for the browser runtime, the claude / codex CLIs). Only the folders that exist are added,
# in front, and none twice.
$candidates = @($env:NVM_SYMLINK)
if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.local\bin'), (Join-Path $env:USERPROFILE '.claude\local') }
if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'npm') }
$current = @($env:PATH -split ';' | Where-Object { $_ -ne '' } | ForEach-Object { $_.TrimEnd('\').ToLowerInvariant() })
$front = @()
foreach ($dir in $candidates) {
    if ([string]::IsNullOrEmpty($dir)) { continue }
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
    if ($current -contains $dir.TrimEnd('\').ToLowerInvariant()) { continue }
    $front += $dir
}
if ($front.Count -gt 0) { $env:PATH = ($front -join ';') + ';' + $env:PATH }

$env:NODE_PATH = (Join-Path $bundle 'node_modules') + $(if ($env:NODE_PATH) { ';' + $env:NODE_PATH } else { '' })

# Service mode. The hub runs under cmd.exe so that the shell does the redirection: everything it writes (and a crash's last words)
# lands in one file in the bytes it wrote, UTF-8. The command line is built here as one string and every path reaches cmd
# through an environment variable, so a prefix with spaces, parentheses or & needs no quoting beyond the surrounding quotes.
# A log over 10 MB is moved aside (one previous file is kept) when the hub starts; if that fails it is reported in the log and the hub starts anyway.
function Start-HubService([string]$Node, [string]$Entry, [string]$Log) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Log) | Out-Null
    # Rotation is best effort: a log that another program holds open cannot be moved, and that must not keep the hub from starting.
    $rotationFailure = $null
    try {
        if ((Test-Path -LiteralPath $Log -PathType Leaf) -and ((Get-Item -LiteralPath $Log).Length -gt 10MB)) {
            Move-Item -LiteralPath $Log -Destination "$Log.1" -Force
        }
    } catch {
        $rotationFailure = $_.Exception.Message
    }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $info.Arguments = '/d /s /c ""%AZITO_HUB_NODE%" "%AZITO_HUB_ENTRY%" >>"%AZITO_HUB_LOG%" 2>&1"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.EnvironmentVariables['AZITO_HUB_NODE'] = $Node
    $info.EnvironmentVariables['AZITO_HUB_ENTRY'] = $Entry
    $info.EnvironmentVariables['AZITO_HUB_LOG'] = $Log
    # The task runs this script under `conhost.exe --headless`: that process is what "End" ends, and what the hub follows. It is checked here, at the
    # last moment before the hub starts (an End that came in since the launcher looked leaves nothing for the hub to follow).
    $followed = Get-Process -Id $FollowPid -ErrorAction SilentlyContinue
    if (-not $followed -or $followed.StartTime.ToFileTimeUtc() -ne $FollowStart) {
        [System.IO.File]::AppendAllText($Log, "[$([DateTime]::UtcNow.ToString('o'))] run.ps1: the process to follow ($FollowPid) is gone, so the hub is not started`r`n")
        return 0
    }
    $info.EnvironmentVariables['AZITO_HUB_EXIT_WITH_PID'] = [string]$FollowPid
    if ($rotationFailure) {
        [System.IO.File]::AppendAllText($Log, "[$([DateTime]::UtcNow.ToString('o'))] run.ps1: could not move the log over 10 MB aside, so it keeps growing: $rotationFailure`r`n")
    }
    $process = [System.Diagnostics.Process]::Start($info)
    $process.WaitForExit()
    return $process.ExitCode
}

try {
    if ($Service) {
        $hubExit = Start-HubService (Join-Path $bundle 'node.exe') (Join-Path $bundle 'azito-hub.cjs') $LogFile
    } else {
        & (Join-Path $bundle 'node.exe') (Join-Path $bundle 'azito-hub.cjs')
        $hubExit = $LASTEXITCODE
    }
} finally {
    try {
        if ($null -ne $restoreOutput) { [Console]::OutputEncoding = $restoreOutput }
        if ($null -ne $restoreInput) { [Console]::InputEncoding = $restoreInput }
    } catch {
        [Console]::Error.WriteLine("run.ps1: could not restore the console encoding: $($_.Exception.Message)")
    }
}
exit $hubExit

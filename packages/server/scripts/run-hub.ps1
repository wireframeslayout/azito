# AZITO hub launcher for Windows (the bundle's run.ps1; run-hub.sh is its Unix counterpart).
# Runs under Windows PowerShell 5.1, never asks a question (a scheduled task may start it), runs the hub in the
# foreground and exits with the hub's exit code.
$ErrorActionPreference = 'Stop'

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

# UTF-8 for the console and for what the hub prints. A process without a console (a scheduled task) has no code page to
# set, so a failure is reported and the hub still starts.
try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8
    [Console]::InputEncoding = $utf8
    $OutputEncoding = $utf8
    & "$env:SystemRoot\System32\chcp.com" 65001 | Out-Null
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

& (Join-Path $bundle 'node.exe') (Join-Path $bundle 'azito-hub.cjs')
exit $LASTEXITCODE

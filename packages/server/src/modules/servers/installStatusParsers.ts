export interface InstallStatusItem {
  installed: boolean;
  version?: string;
  detail?: string;
}

export function parseTmuxVersion(stdout: string, code: number): InstallStatusItem {
  const version = stdout.trim();
  return code === 0 && version
    ? { installed: true, version }
    : { installed: false, detail: 'tmux not found' };
}

export function parseNodeVersion(stdout: string): InstallStatusItem {
  const raw = stdout.trim().replace(/^v/, '');
  const major = parseInt(raw.split('.')[0], 10);
  if (isNaN(major)) return { installed: false, detail: 'node not found' };
  return { installed: true, version: `v${raw}`, detail: major < 24 ? 'v24+ required' : undefined };
}

export interface HarnessCheckResult extends InstallStatusItem {
  outdated?: boolean;
  installedVersion?: string;
  expectedVersion?: string;
  autoUpdate?: { status: string; message?: string; at?: string };
}

export function parseHarnessCheck(
  stdout: string,
  expectedHash?: string,
  autoUpdateResult?: { status: string; message?: string; at?: string },
): HarnessCheckResult {
  const lines = stdout.split('\n');
  const dirExists = lines[0]?.trim();
  if (!dirExists) return { installed: false, detail: 'azt-harness not installed' };

  const remoteVersion = lines[1]?.trim() || undefined;
  const result: HarnessCheckResult = { installed: true };

  if (expectedHash) {
    result.outdated = remoteVersion !== expectedHash;
    if (remoteVersion) result.installedVersion = remoteVersion;
    result.expectedVersion = expectedHash;
  }
  if (autoUpdateResult) {
    result.autoUpdate = autoUpdateResult;
  }
  return result;
}

export function parseTailscaleCheck(stdout: string): InstallStatusItem {
  const ip = stdout.trim();
  return ip
    ? { installed: true, version: ip }
    : { installed: false, detail: 'tailscale not configured' };
}

export function parseChromiumInstall(stdout: string): InstallStatusItem {
  const match = stdout.trim().match(/chromium-(\d+)/);
  return match
    ? { installed: true, version: `chromium-${match[1]}` }
    : { installed: false, detail: 'Chromium not installed (run Browser runtime install)' };
}

export function buildHarnessCheckCommand(prefix?: string): string {
  const harnessDir = `~/.azito/harness${prefix ? `-${prefix}` : ''}`;
  return `ls -d ${harnessDir}/skills ~/.claude/skills/azt-* 2>/dev/null | head -1; cat ${harnessDir}/VERSION 2>/dev/null`;
}

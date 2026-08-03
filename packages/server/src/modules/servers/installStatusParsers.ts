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

export function parseHarnessCheck(stdout: string): InstallStatusItem {
  return stdout.trim()
    ? { installed: true }
    : { installed: false, detail: 'azt-harness not installed' };
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

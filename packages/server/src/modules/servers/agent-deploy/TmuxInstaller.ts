import type { IServerTransport } from '../transport/ServerTransport';

const TMUX_VERSION = '3.6b';

const BINARIES: Record<string, { url: string; sha256: string }> = {
  x86_64: {
    url: `https://github.com/pythops/tmux-linux-binary/releases/download/v${TMUX_VERSION}/tmux-linux-x86_64`,
    sha256: '4604cafd0b13dd05ddc6ba8a42e2bd79755f22c7a410cfb9797ed06f1cd78467',
  },
  aarch64: {
    url: `https://github.com/pythops/tmux-linux-binary/releases/download/v${TMUX_VERSION}/tmux-linux-arm64`,
    sha256: '26d23ee61af2719c206795279d6d35dddc51a42d9806018c99220b21fe0fd57f',
  },
};

// base-index/pane-base-index 1 is required, not cosmetic: pane targets are
// addressed as `<session>:<window>.1` throughout the server (e.g. launch-agent)
const AZITO_CONF = `set -s escape-time 10
set -g focus-events on
set -g history-limit 50000
set -g mouse on
set -g base-index 1
set -g pane-base-index 1
`;

export interface TmuxInstallResult {
  success: boolean;
  version?: string;
  error?: string;
}

export function buildApplyTmuxConfigCommands(homeDir: string): string[] {
  const confDir = `${homeDir}/.azito/tmux`;
  const confPath = `${confDir}/azito.conf`;
  const sourceLine = `source-file ${confPath}`;
  return [
    `mkdir -p "${confDir}"`,
    `[ -f "${confPath}" ] || printf '%s' '${AZITO_CONF.replace(/'/g, "'\\''")}' > "${confPath}"`,
    `grep -qxF '${sourceLine}' ~/.tmux.conf 2>/dev/null || echo '${sourceLine}' >> ~/.tmux.conf`,
  ];
}

export class TmuxInstaller {
  async install(transport: IServerTransport): Promise<TmuxInstallResult> {
    try {
      const osResult = await transport.exec('uname -s');
      const osName = osResult.stdout.trim();
      if (osName !== 'Linux') {
        return { success: false, error: `managed tmux は Linux のみ対応。${osName} は後続イシューで対応予定` };
      }

      const archResult = await transport.exec('uname -m');
      const rawArch = archResult.stdout.trim();
      const arch = rawArch === 'arm64' ? 'aarch64' : rawArch;
      const binary = BINARIES[arch];
      if (!binary) {
        return { success: false, error: `Unsupported architecture: ${rawArch}. Supported: x86_64, aarch64/arm64` };
      }

      const homeResult = await transport.exec('echo $HOME');
      const home = homeResult.stdout.trim();
      const dir = `${home}/.azito/tmux`;
      const binDir = `${dir}/bin`;
      const tmpFile = `${binDir}/tmux.tmp`;
      const finalFile = `${binDir}/tmux`;
      const confFile = `${dir}/azito.conf`;

      await transport.exec(`mkdir -p "${binDir}"`);

      const dlResult = await transport.exec(`curl -fsSL "${binary.url}" -o "${tmpFile}"`);
      if (dlResult.code !== 0) {
        return { success: false, error: `Download failed: ${dlResult.stderr}` };
      }

      const shaResult = await transport.exec(`sha256sum "${tmpFile}" | awk '{print $1}'`);
      const actualSha = shaResult.stdout.trim();
      if (actualSha !== binary.sha256) {
        await transport.exec(`rm -f "${tmpFile}"`);
        throw new Error(`SHA256 mismatch: expected ${binary.sha256}, got ${actualSha}`);
      }

      await transport.exec(`chmod 755 "${tmpFile}" && mv "${tmpFile}" "${finalFile}"`);

      const confEscaped = AZITO_CONF.replace(/'/g, "'\\''");
      await transport.exec(`printf '%s' '${confEscaped}' > "${confFile}"`);

      const verifyResult = await transport.exec(`"${finalFile}" -V`);
      const version = verifyResult.stdout.trim();
      if (!version) {
        return { success: false, error: 'Installed binary did not return version' };
      }

      return { success: true, version };
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message };
    }
  }
}

import os from 'os';

export type HostPlatform = 'linux' | 'darwin' | 'win32';
export type HostArch = 'x64' | 'arm64';

/**
 * この Node プロセスが動くホストの環境。ハブ・エージェント・CLI がそれぞれ起動時に 1 回だけ解決し、
 * コアには解決済みの値を渡す（コアの中で process.env.HOME / process.platform を読まない）。
 */
export interface HostEnv {
  platform: HostPlatform;
  arch: HostArch;
  homeDir: string;
  tmpDir: string;
  pathDelimiter: string;
  execPath: string;
}

export interface HostEnvInput {
  platform: string;
  arch: string;
  homeDir: string;
  tmpDir: string;
  execPath: string;
}

const SUPPORTED_PLATFORMS: readonly HostPlatform[] = ['linux', 'darwin', 'win32'];
const SUPPORTED_ARCHES: readonly HostArch[] = ['x64', 'arm64'];

function isHostPlatform(value: string): value is HostPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

function isHostArch(value: string): value is HostArch {
  return (SUPPORTED_ARCHES as readonly string[]).includes(value);
}

/** 純粋関数。未対応の platform / arch と空の homeDir は理由付きで投げる（フォールバックしない）。 */
export function resolveHostEnv(input: HostEnvInput): HostEnv {
  if (!isHostPlatform(input.platform)) {
    throw new Error(`Unsupported platform "${input.platform}" (supported: ${SUPPORTED_PLATFORMS.join(', ')})`);
  }
  if (!isHostArch(input.arch)) {
    throw new Error(`Unsupported architecture "${input.arch}" (supported: ${SUPPORTED_ARCHES.join(', ')})`);
  }
  if (input.homeDir === '') {
    throw new Error('Cannot resolve the home directory: os.homedir() returned an empty string');
  }
  return {
    platform: input.platform,
    arch: input.arch,
    homeDir: input.homeDir,
    tmpDir: input.tmpDir,
    pathDelimiter: input.platform === 'win32' ? ';' : ':',
    execPath: input.execPath,
  };
}

/** 実プロセスから読む。`process.platform` を読んでよいのはここだけ。各プロセスの入口で 1 回呼ぶ。 */
export function resolveCurrentHostEnv(): HostEnv {
  return resolveHostEnv({
    platform: process.platform,
    arch: process.arch,
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    execPath: process.execPath,
  });
}

import os from 'os';

/** 対応を明示するプラットフォーム / アーキテクチャ。絞り込み関数は、使う側（P5 の hostProfile など）で足す。 */
export type HostPlatform = 'linux' | 'darwin' | 'win32';
export type HostArch = 'x64' | 'arm64';

/**
 * この Node プロセスが動くホストの環境。ハブ・エージェント・CLI がそれぞれ起動時に 1 回だけ解決し、
 * コアには解決済みの値を渡す（コアの中で process.env.HOME / process.platform を読まない）。
 * platform / arch は Node の値そのまま（未対応の OS でもプロセスは起動する。拒否は使う側が行う）。
 */
export interface HostEnv {
  platform: NodeJS.Platform;
  arch: string;
  homeDir: string;
  execPath: string;
}

/** 純粋関数。homeDir が空のときだけ投げる（フォールバックしない）。 */
export function resolveHostEnv(input: HostEnv): HostEnv {
  if (input.homeDir === '') {
    throw new Error('Cannot resolve the home directory: os.homedir() returned an empty string (is HOME set to an empty value?)');
  }
  return { platform: input.platform, arch: input.arch, homeDir: input.homeDir, execPath: input.execPath };
}

/** 実プロセスから読む。`process.platform` を読んでよいのはここだけ。各プロセスの入口で 1 回呼ぶ。 */
export function resolveCurrentHostEnv(): HostEnv {
  return resolveHostEnv({
    platform: process.platform,
    arch: process.arch,
    homeDir: os.homedir(),
    execPath: process.execPath,
  });
}

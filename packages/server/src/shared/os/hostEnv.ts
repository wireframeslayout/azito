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
  /** このホストの一時フォルダ（`os.tmpdir()`）。ハブ自身のサーバーの signal / output / rules / pipe ファイルを置く。 */
  tmpDir: string;
  execPath: string;
  /** このプロセスのユーザー ID（launchd のドメイン `gui/<uid>` / `user/<uid>` に使う）。Windows には無く、Node は -1 を返す。 */
  uid: number;
}

/** 純粋関数。homeDir / tmpDir が空のときだけ投げる（フォールバックしない）。 */
export function resolveHostEnv(input: HostEnv): HostEnv {
  if (input.homeDir === '') {
    throw new Error('Cannot resolve the home directory: os.homedir() returned an empty string (is HOME set to an empty value?)');
  }
  if (input.tmpDir === '') {
    throw new Error('Cannot resolve the temp directory: os.tmpdir() returned an empty string');
  }
  return { platform: input.platform, arch: input.arch, homeDir: input.homeDir, tmpDir: input.tmpDir, execPath: input.execPath, uid: input.uid };
}

/** 実プロセスから読む。`process.platform` を読んでよいのはここだけ。各プロセスの入口で 1 回呼ぶ。 */
export function resolveCurrentHostEnv(): HostEnv {
  return resolveHostEnv({
    platform: process.platform,
    arch: process.arch,
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    execPath: process.execPath,
    uid: os.userInfo().uid,
  });
}

// 「tmux が入っていないホスト」を再現する PATH を作る。
//
// ホストの tmux は消せないので、PATH のうち tmux を含むディレクトリを「tmux 以外の全エントリへの
// シンボリックリンクだけを並べたミラー」に置き換える。git / node / sh など他のコマンドは従来どおり
// 引けて、`tmux` だけが ENOENT になる（ハブが見るのと同じ「バイナリ無し」）。

import fs from 'node:fs';
import path from 'node:path';

/**
 * `basePath`（PATH 形式）から tmux を引けなくした PATH を返す。ミラーは `workDir` 配下に作る
 * （呼び出し側が workDir ごと後片付けする）。tmux を含まないディレクトリはそのまま使う。
 */
export function pathWithoutTmux(basePath: string, workDir: string): string {
  const mirrors = new Map<string, string>();
  const entries = basePath.split(path.delimiter).filter((dir) => dir !== '').map((dir) => {
    if (!fs.existsSync(path.join(dir, 'tmux'))) return dir;
    // /bin と /usr/bin のように同じ実体を指す別名は 1 つのミラーにまとめる。
    const real = fs.realpathSync(dir);
    let mirror = mirrors.get(real);
    if (!mirror) {
      mirror = path.join(workDir, `path-mirror-${mirrors.size}`);
      fs.mkdirSync(mirror, { recursive: true });
      for (const name of fs.readdirSync(real)) {
        if (name === 'tmux') continue;
        fs.symlinkSync(path.join(real, name), path.join(mirror, name));
      }
      mirrors.set(real, mirror);
    }
    return mirror;
  });
  return entries.join(path.delimiter);
}

/** `path` の中に tmux が残っていないことの確認（ミラー作成の取りこぼしを fixture の起動時に検出する）。 */
export function assertNoTmux(searchPath: string): void {
  for (const dir of searchPath.split(path.delimiter)) {
    if (dir !== '' && fs.existsSync(path.join(dir, 'tmux'))) {
      throw new Error(`tmux is still reachable through PATH entry ${dir}`);
    }
  }
}

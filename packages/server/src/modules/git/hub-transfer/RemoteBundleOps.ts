import * as crypto from 'crypto';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { shellQuote } from '../../../shared/shellQuote';
import { assertSafeBranch } from '../assertSafeGitArgs';
import { DUMMY_ORIGIN_URL } from './types';

/**
 * サーバー側の配布専用 bare mirror（`~/.azito/repos/<repoHash>.git`）と、そこから
 * 用意される workingDir を操作する（Issue #87 Phase 2: bare mirror レイアウト）。
 *
 * セキュリティ上の注意: mirror は配信先サーバー上で、隔離対象タスクと同一の Unix
 * ユーザー権限の下に置かれる。タスクは元々そのユーザーで任意コード実行できるため
 * これは権限昇格ではないが、タスクが mirror の refs/objects/config を書き換え、
 * 次回配信時に汚染された内容を workingDir へ伝播させる（あるいは配信自体を妨害
 * する）余地は残る。所有権分離は本改修の範囲外とし、mirror に触れる全ての git
 * 実行に `-c core.hooksPath=/dev/null` を付けることで hook 実行だけは防ぐに留める。
 */
export class RemoteBundleOps {
  async verify(transport: IServerTransport, remoteBundlePath: string): Promise<boolean> {
    const r = await transport.exec(`git bundle verify ${shellQuote(remoteBundlePath)} 2>&1`, 30_000);
    return r.code === 0 && !r.stderr?.includes('fatal:');
  }

  /** サーバーのホームディレクトリを解決する（`TmuxInstaller` と同じ `$HOME` 規約）。 */
  async resolveHomeDir(transport: IServerTransport): Promise<string> {
    const r = await transport.exec('echo $HOME', 5_000);
    const home = r.stdout?.trim();
    if (!home) {
      throw new Error('Failed to resolve $HOME on remote server');
    }
    return home;
  }

  mirrorDir(homeDir: string, repoHash: string): string {
    return `${homeDir}/.azito/repos/${repoHash}.git`;
  }

  async mirrorExists(transport: IServerTransport, mirrorDir: string): Promise<boolean> {
    const r = await transport.exec(`test -f ${shellQuote(mirrorDir + '/HEAD')} && echo yes || echo no`, 5_000);
    return r.stdout?.trim() === 'yes';
  }

  /** サーバー側 mirror を冪等に用意する（既にあれば何もしない）。 */
  async ensureMirror(transport: IServerTransport, mirrorDir: string): Promise<void> {
    const exists = await this.mirrorExists(transport, mirrorDir);
    if (exists) return;
    const r = await transport.exec(
      `mkdir -p ${shellQuote(mirrorDir)} && git -c core.hooksPath=/dev/null init --bare ${shellQuote(mirrorDir)} 2>&1`,
      15_000,
    );
    if (r.code !== 0 || (r.stderr && r.stderr.includes('fatal:'))) {
      throw new Error(`git init --bare for mirror failed: ${r.stderr || r.stdout}`);
    }
  }

  /**
   * mirror が実際に受信済みの branch head を照会する。増分配信の prerequisite は
   * ここで得た値のみを根拠にする（DB の `last_distributed_sha` は使わない —
   * force-push 後にずれると永久に増分が失敗し続けるバグの原因だったため）。
   * 未配信（ref が無い）なら null。
   */
  async getMirrorBranchSha(transport: IServerTransport, mirrorDir: string, branch: string): Promise<string | null> {
    assertSafeBranch(branch, 'branch');
    const r = await transport.exec(
      `git -C ${shellQuote(mirrorDir)} rev-parse --verify ${shellQuote(`refs/heads/${branch}`)} 2>/dev/null`,
      10_000,
    );
    const sha = r.stdout?.trim();
    return r.code === 0 && !!sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  /**
   * bundle を mirror へ取り込む。強制 refspec（`+`）+ `--atomic` — 上流の
   * force-push を受けても non-fast-forward で失敗しない（確認済みバグの修正）。
   */
  async fetchBundleIntoMirror(transport: IServerTransport, mirrorDir: string, remoteBundlePath: string, branch: string): Promise<void> {
    assertSafeBranch(branch, 'branch');
    const refspec = `+refs/heads/${branch}:refs/heads/${branch}`;
    const r = await transport.exec(
      `git -C ${shellQuote(mirrorDir)} -c core.hooksPath=/dev/null fetch --atomic ${shellQuote(remoteBundlePath)} ${shellQuote(refspec)} 2>&1`,
      120_000,
    );
    if (r.code !== 0 || (r.stderr && r.stderr.includes('fatal:'))) {
      throw new Error(`git fetch bundle into mirror failed: ${r.stderr || r.stdout}`);
    }
  }

  /**
   * workingDir が未作成のとき、mirror から新規作成する。`--branch <branch>` で
   * clone した時点のローカル branch はその時点の内容を指すが、以後
   * `fetchWorkingDirFromMirror` はこのローカル branch を一切更新しない
   * （下記参照）。workingDir はリンク worktree の起点として使われるだけであり、
   * 更新後の内容が必要な呼び出し側は `origin/<branch>` を参照すること。
   *
   * HEAD の detach はここでは行わない。`ensureDetachedHead()` を参照。
   */
  async cloneWorkingDirFromMirror(transport: IServerTransport, mirrorDir: string, workingDir: string, branch: string): Promise<void> {
    assertSafeBranch(branch, 'branch');
    // `--no-local` 必須: ローカル clone の hardlink 最適化は source（mirror）の
    // 並行更新と race する既知の git-clone の性質のため。
    const r = await transport.exec(
      `git -c core.hooksPath=/dev/null clone --no-local --branch ${shellQuote(branch)} ${shellQuote(mirrorDir)} ${shellQuote(workingDir)} 2>&1`,
      120_000,
    );
    if (r.code !== 0 || (r.stderr && r.stderr.includes('fatal:'))) {
      throw new Error(`git clone from mirror failed: ${r.stderr || r.stdout}`);
    }
  }

  /**
   * workingDir の HEAD を detach する（既に detach 済みでも成功する冪等操作）。
   *
   * workingDir は配信先であり人が作業する場所ではない（タスクは worktree で
   * 作業する）。主チェックアウトが branch を掴んだままだと、タスクのブランチ
   * 指定がベースブランチと同じ場合に `RemoteWorktreeService` の
   * `git worktree add <path> <branch>`（既存ローカル branch を割り当てる
   * 分岐）が `fatal: '<branch>' is already used by worktree` で失敗する。
   *
   * clone 手順の一部として一度だけ実行すると、detach だけが失敗したケースで
   * `workingDir/.git` は既に存在するため、次回配信は `repoExists` により
   * 「既存」と判定されて fetch 経路へ入り、detach は二度と試みられなくなる
   * （Issue #87 レビュー指摘）。この対策として、`FetchDistributionService`
   * の `ensureWorkingDir()` は clone 経路・fetch 経路のどちらでも毎回このメ
   * ソッドを呼ぶ。冪等に適用することで、一度失敗しても次回の配信で回復する。
   */
  async ensureDetachedHead(transport: IServerTransport, workingDir: string): Promise<void> {
    const r = await transport.exec(
      `git -C ${shellQuote(workingDir)} -c core.hooksPath=/dev/null checkout --detach 2>&1`,
      15_000,
    );
    if (r.code !== 0 || (r.stderr && r.stderr.includes('fatal:'))) {
      throw new Error(`git checkout --detach failed: ${r.stderr || r.stdout}`);
    }
  }

  /**
   * 既存 workingDir を mirror から更新する。`origin` リモート越しではなく mirror
   * パスを source に明示指定する（`origin` の URL は別ポリシーの `setDummyOrigin`
   * が管理しており、更新経路とは分離するため）。
   *
   * **ローカル branch ref は更新しない** — 追跡 ref
   * （`refs/remotes/origin/<branch>`）のみを forced 更新する1本の refspec。
   * ローカル branch を forced refspec で書き換える方式は、その branch がどこかの
   * リンク worktree（`git worktree add <path> <branch>`。タスクがベースブランチ名
   * をそのまま指定した場合など）でチェックアウトされていると
   * `refusing to fetch into branch ... checked out` で fetch 自体が失敗し、以後
   * その サーバー×リポジトリ への配信が全て失敗し続ける（Issue #87 レビュー
   * 指摘）。workingDir のローカル branch は clone 時点のまま更新されなくなるため、
   * 更新後の内容が必要な呼び出し側（worktree 作成など）は境界側で
   * `origin/<branch>` を明示的に指定すること。
   */
  async fetchWorkingDirFromMirror(transport: IServerTransport, mirrorDir: string, workingDir: string, branch: string): Promise<void> {
    assertSafeBranch(branch, 'branch');
    const trackingRefspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
    const r = await transport.exec(
      `cd ${shellQuote(workingDir)} && git -c core.hooksPath=/dev/null fetch --atomic ${shellQuote(mirrorDir)} ${shellQuote(trackingRefspec)} 2>&1`,
      120_000,
    );
    if (r.code !== 0 || (r.stderr && r.stderr.includes('fatal:'))) {
      throw new Error(`git fetch from mirror failed: ${r.stderr || r.stdout}`);
    }
  }

  /**
   * 配信直後、workingDir の**ローカル** branch ref を追跡 ref
   * （`refs/remotes/origin/<branch>`）に追随させる（Issue #87 レビュー指摘2）。
   *
   * `fetchWorkingDirFromMirror` は上のコメントの通り、意図的に追跡 ref のみを
   * 更新し、ローカル branch には一切触れない。そのため、タスクが
   * `task.branch` に既存のローカル branch 名（典型的にはベースブランチ名その
   * もの）を指定した場合、`RemoteWorktreeService.create()` の「既存 branch
   * を割り当てる」経路（`git worktree add <path> <branch>`）は baseBranch
   * 解決を完全にバイパスし、配信が成功していても更新されない古いローカル
   * branch から worktree を作ってしまう。このメソッドはその隙間を埋めるため、
   * 配信直後に限りローカル branch を追跡 ref の位置まで強制的に進める。
   *
   * **失敗しても例外にせず false を返す** — 対象 branch が既に別のリンク
   * worktree でチェックアウトされている場合、`git branch -f` はそれを拒否し
   * て失敗する。しかしその状況では、この直後に呼ばれる
   * `RemoteWorktreeService.create()` の「既存 branch を割り当てる」経路
   * （`git worktree add <path> <branch>`）も必ず `already used by worktree`
   * で失敗するため、古い内容のまま静かに worktree 作成が成功してしまう経路は
   * 存在しない — 失敗を許容しても「黙って古いコードを使い続ける」結果には
   * ならない。
   *
   * 逆に、この更新を独立したコマンドとして切り出さず
   * `fetchWorkingDirFromMirror` の fetch refspec 側に混ぜてしまうと、その
   * fetch 全体が対象 branch のチェックアウト状態次第で
   * "refusing to fetch into branch ... checked out" により失敗し、配信自体
   * が完全に止まってしまう（`fetchWorkingDirFromMirror` のコメント参照、
   * 既知の再発バグ）。そのため意図的に独立したコマンドとして分離している。
   */
  async syncLocalBranchToTracking(transport: IServerTransport, workingDir: string, branch: string): Promise<boolean> {
    assertSafeBranch(branch, 'branch');
    const r = await transport.exec(
      `git -C ${shellQuote(workingDir)} -c core.hooksPath=/dev/null branch -f ${shellQuote(branch)} ${shellQuote(`refs/remotes/origin/${branch}`)} 2>&1`,
      15_000,
    );
    return r.code === 0 && !(r.stderr && r.stderr.includes('fatal:'));
  }

  async createFromWorktree(transport: IServerTransport, worktreePath: string, branch: string, baseBranch: string | null): Promise<string> {
    assertSafeBranch(branch, 'branch');
    if (baseBranch) assertSafeBranch(baseBranch, 'baseBranch');
    const nonce = crypto.randomBytes(8).toString('hex');
    const remoteBundlePath = `/tmp/azito-push-${nonce}.bundle`;

    const notClause = baseBranch
      ? `--not ${shellQuote(`origin/${baseBranch}`)}`
      : '';
    const r = await transport.exec(
      `cd ${shellQuote(worktreePath)} && git bundle create ${shellQuote(remoteBundlePath)} ${shellQuote(branch)} ${notClause} 2>&1`,
      120_000,
    );
    if (r.code !== 0 || (r.stderr && r.stderr.includes('fatal:'))) {
      throw new Error(`git bundle create failed: ${r.stderr || r.stdout}`);
    }
    return remoteBundlePath;
  }

  async setDummyOrigin(transport: IServerTransport, targetDir: string): Promise<void> {
    await transport.exec(
      `cd ${shellQuote(targetDir)} && git remote set-url origin ${shellQuote(DUMMY_ORIGIN_URL)} 2>&1`,
      10_000,
    );
  }

  async getHeadSha(transport: IServerTransport, dir: string): Promise<string | null> {
    const r = await transport.exec(`cd ${shellQuote(dir)} && git rev-parse HEAD 2>/dev/null`, 10_000);
    const sha = r.stdout?.trim();
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  async repoExists(transport: IServerTransport, dir: string): Promise<boolean> {
    const r = await transport.exec(`test -d ${shellQuote(dir + '/.git')} && echo yes || echo no`, 5_000);
    return r.stdout?.trim() === 'yes';
  }

  async cleanup(transport: IServerTransport, remotePath: string): Promise<void> {
    await transport.exec(`rm -f ${shellQuote(remotePath)}`, 5_000);
  }
}

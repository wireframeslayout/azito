import * as crypto from 'crypto';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { shellQuote } from '../../../shared/shellQuote';
import { assertSafeBranch } from '../assertSafeGitArgs';
import { execGitOrThrow, execWithSentinel, RemoteGitCommandError } from '../execWithSentinel';
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
  /**
   * `code`/`stderr` are not trustworthy on `ssh` servers — see
   * `execWithSentinel`'s doc comment. Uses the exit-status sentinel
   * (Issue #87 third-party review, seventh pass, Important finding 1)
   * instead of the earlier `hasGitError` text scan, which missed any
   * failure that didn't print in git's own `fatal:`/`error:` format.
   *
   * `git bundle verify` requires a repository context to check the bundle's
   * prerequisite commits against — run without `-C <mirrorDir>` it fails
   * unconditionally with `error: need a repository to verify a bundle`
   * (confirmed by hand), so every verify — full and incremental alike —
   * failed and distribution was completely broken (Issue #87 third-party
   * review, fourth pass, Important finding 1). `mirrorDir` is the
   * server-side bare mirror `FetchDistributionService.ensureMirror()`
   * guarantees exists before `verify()` is ever called.
   *
   * Throws `RemoteGitCommandError` with `transportFailure: true` when the
   * sentinel never arrives — the caller (`FetchDistributionService`'s
   * `uploadVerifyApply`) translates that into a `BundleTransferError` so a
   * transport-layer anomaly doesn't trigger a pointless full-bundle
   * fallback (Issue #87 third-party review, seventh pass, Important
   * finding 2). A GENUINE verify rejection (sentinel present, non-zero
   * exit) still returns `false`, unchanged from before.
   */
  async verify(transport: IServerTransport, mirrorDir: string, remoteBundlePath: string): Promise<boolean> {
    const outcome = await execWithSentinel(
      transport,
      `git -C ${shellQuote(mirrorDir)} bundle verify ${shellQuote(remoteBundlePath)} 2>&1`,
      30_000,
    );
    if (!outcome.sentinelFound) {
      throw new RemoteGitCommandError('git bundle verify did not complete (transport/execution failure)', {
        transportFailure: true,
      });
    }
    return outcome.ok;
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
    await execGitOrThrow(
      transport,
      `mkdir -p ${shellQuote(mirrorDir)} && git -c core.hooksPath=/dev/null init --bare ${shellQuote(mirrorDir)} 2>&1`,
      15_000,
      'git init --bare for mirror failed',
    );
  }

  /**
   * mirror が実際に受信済みの branch head を照会する。増分配信の prerequisite は
   * ここで得た値のみを根拠にする（DB の `last_distributed_sha` は使わない —
   * force-push 後にずれると永久に増分が失敗し続けるバグの原因だったため）。
   * 未配信（ref が無い）なら null。
   */
  async getMirrorBranchSha(transport: IServerTransport, mirrorDir: string, branch: string): Promise<string | null> {
    assertSafeBranch(branch, 'branch');
    // Intentionally NOT `hasGitError` here: "the branch doesn't exist in the
    // mirror yet" is a NORMAL outcome (first-ever distribution), not a
    // failure to detect — it must return `null`, not throw. `r.code` is
    // also not trustworthy on `ssh` (see `hasGitError`'s doc comment), but
    // that doesn't matter here: stderr is redirected to `/dev/null` on the
    // REMOTE shell (real redirection, applied before the transport ever
    // sees the output — unlike the `2>&1` used elsewhere in this file,
    // which only merges streams that the transport itself may then discard
    // stderr from). The result is decided purely by whether stdout is a
    // well-formed 40-hex sha.
    const r = await transport.exec(
      `git -C ${shellQuote(mirrorDir)} rev-parse --verify ${shellQuote(`refs/heads/${branch}`)} 2>/dev/null`,
      10_000,
    );
    const sha = r.stdout?.trim();
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  /**
   * bundle を mirror へ取り込む。強制 refspec（`+`）+ `--atomic` — 上流の
   * force-push を受けても non-fast-forward で失敗しない（確認済みバグの修正）。
   */
  async fetchBundleIntoMirror(transport: IServerTransport, mirrorDir: string, remoteBundlePath: string, branch: string): Promise<void> {
    assertSafeBranch(branch, 'branch');
    const refspec = `+refs/heads/${branch}:refs/heads/${branch}`;
    await execGitOrThrow(
      transport,
      `git -C ${shellQuote(mirrorDir)} -c core.hooksPath=/dev/null fetch --atomic ${shellQuote(remoteBundlePath)} ${shellQuote(refspec)} 2>&1`,
      120_000,
      'git fetch bundle into mirror failed',
    );
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
    await execGitOrThrow(
      transport,
      `git -c core.hooksPath=/dev/null clone --no-local --branch ${shellQuote(branch)} ${shellQuote(mirrorDir)} ${shellQuote(workingDir)} 2>&1`,
      120_000,
      'git clone from mirror failed',
    );
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
    await execGitOrThrow(
      transport,
      `git -C ${shellQuote(workingDir)} -c core.hooksPath=/dev/null checkout --detach 2>&1`,
      15_000,
      'git checkout --detach failed',
    );
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
    await execGitOrThrow(
      transport,
      `cd ${shellQuote(workingDir)} && git -c core.hooksPath=/dev/null fetch --atomic ${shellQuote(mirrorDir)} ${shellQuote(trackingRefspec)} 2>&1`,
      120_000,
      'git fetch from mirror failed',
    );
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
   * て失敗する。
   *
   * （訂正 — Issue #87 review, forge/87-mirror follow-up, Important finding
   * 1）当初はここで「この直後に呼ばれる `RemoteWorktreeService.create()` の
   * 『既存 branch を割り当てる』経路（`git worktree add <path> <branch>`）
   * も必ず `already used by worktree` で失敗するため、古い内容のまま静かに
   * worktree 作成が成功してしまう経路は存在しない」と説明していたが、これは
   * **誤り**だった。`RemoteWorktreeService.create()`（RemoteWorktreeService.ts
   * 64行目付近）は `git worktree add` が `already used by worktree` で失敗
   * すると `git worktree prune` を挟んで再試行し、それでも失敗した場合は
   * **`git worktree add --force`** で再々試行する。この force 経路は同期が
   * 進まなかった古いローカル ref に対しても成功してしまうため、「失敗を許容
   * しても黙って古いコードを使い続ける結果にはならない」という前提は成り立
   * たない（実地検証: `git worktree add <path> main` は `already used by
   * worktree` で失敗するが `git worktree add --force <path> main` は同じ古い
   * ref に対して成功する）。したがって、この関数自体は引き続き例外を投げず
   * `boolean` を返す設計のままとするが、**戻り値の意味づけは呼び出し側の
   * 責務**になる — `FetchDistributionService`/`ExecuteTaskUseCase` 側で、
   * この false が実害（`task.branch` が配信対象 baseBranch と同名で
   * force 経路により古い ref から worktree が作られ得る場合）に繋がるかを
   * 判定し、繋がる場合のみ fail fast する。
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
    // A transport-layer anomaly (sentinel missing) is folded into the same
    // `false` this method already returns for a genuine `git branch -f`
    // rejection — see this method's doc comment above: callers already
    // treat `false` as "may not have synced, decide fail-fast at the
    // boundary if it matters", so there is no separate signal to plumb
    // through here.
    const outcome = await execWithSentinel(
      transport,
      `git -C ${shellQuote(workingDir)} -c core.hooksPath=/dev/null branch -f ${shellQuote(branch)} ${shellQuote(`refs/remotes/origin/${branch}`)} 2>&1`,
      15_000,
    );
    return outcome.ok;
  }

  async createFromWorktree(transport: IServerTransport, worktreePath: string, branch: string, baseBranch: string | null): Promise<string> {
    assertSafeBranch(branch, 'branch');
    if (baseBranch) assertSafeBranch(baseBranch, 'baseBranch');
    const nonce = crypto.randomBytes(8).toString('hex');
    const remoteBundlePath = `/tmp/azito-push-${nonce}.bundle`;

    const notClause = baseBranch
      ? `--not ${shellQuote(`origin/${baseBranch}`)}`
      : '';
    await execGitOrThrow(
      transport,
      `cd ${shellQuote(worktreePath)} && git bundle create ${shellQuote(remoteBundlePath)} ${shellQuote(branch)} ${notClause} 2>&1`,
      120_000,
      'git bundle create failed',
    );
    return remoteBundlePath;
  }

  async setDummyOrigin(transport: IServerTransport, targetDir: string): Promise<void> {
    await transport.exec(
      `cd ${shellQuote(targetDir)} && git remote set-url origin ${shellQuote(DUMMY_ORIGIN_URL)} 2>&1`,
      10_000,
    );
  }

  /**
   * "No HEAD yet" (empty/missing dir) is a normal branch here, not a
   * failure — so this deliberately does not use `hasGitError`/throw. Same
   * `2>/dev/null` real-redirection + sha-regex-validates-success approach
   * as `getMirrorBranchSha` above (see that method's comment); `r.code` is
   * never consulted.
   */
  async getHeadSha(transport: IServerTransport, dir: string): Promise<string | null> {
    const r = await transport.exec(`cd ${shellQuote(dir)} && git rev-parse HEAD 2>/dev/null`, 10_000);
    const sha = r.stdout?.trim();
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  /**
   * "Not a repo yet" is a normal branch (decides clone vs. fetch in
   * `FetchDistributionService.ensureWorkingDir`), not a failure. The
   * `echo yes || echo no` shell construct encodes the answer directly into
   * stdout, so — like `getMirrorBranchSha`/`getHeadSha` above — this never
   * needs to consult `r.code` at all.
   */
  async repoExists(transport: IServerTransport, dir: string): Promise<boolean> {
    const r = await transport.exec(`test -d ${shellQuote(dir + '/.git')} && echo yes || echo no`, 5_000);
    return r.stdout?.trim() === 'yes';
  }

  async cleanup(transport: IServerTransport, remotePath: string): Promise<void> {
    await transport.exec(`rm -f ${shellQuote(remotePath)}`, 5_000);
  }

  // Git config key `workingDir` is stamped with, recording which repository
  // (`computeRepoHash(repoIdentity)`) that checkout was cloned for (Issue
  // #87 third-party review, 10th round, Important finding 2). See
  // `getStampedRepoHash`/`stampRepoHash` below.
  private static readonly REPO_HASH_CONFIG_KEY = 'azito.repoHash';

  /**
   * Reads the repoHash previously stamped into `workingDir`'s git config by
   * `stampRepoHash()`. Returns `null` when unset — either `workingDir` was
   * never stamped (created before this stamping existed) or the directory
   * has no git config at all yet. `FetchDistributionService.ensureWorkingDir`
   * treats `null` as "skip verification, back-compat" rather than a
   * mismatch, so this must not throw for the missing-key case; `git config
   * --get` already exits non-zero for a missing key without writing
   * anything to stdout, and stderr is redirected away, so a missing key and
   * a transport hiccup both collapse to `null` here — the caller only acts
   * on an actual VALUE mismatch, never on the mere absence of one.
   */
  async getStampedRepoHash(transport: IServerTransport, workingDir: string): Promise<string | null> {
    const r = await transport.exec(
      `git -C ${shellQuote(workingDir)} config --get ${RemoteBundleOps.REPO_HASH_CONFIG_KEY} 2>/dev/null`,
      5_000,
    );
    const value = r.stdout?.trim();
    return value || null;
  }

  /**
   * Stamps `workingDir`'s git config with `repoHash`, so a later
   * distribution to the same path can detect whether it is now being asked
   * to update a checkout that actually belongs to a DIFFERENT repository
   * (two project/server registrations pointed at the same filesystem path —
   * Issue #87 third-party review, 10th round, Important finding 2). Called
   * once right after clone, and once (back-fill) the first time an
   * unstamped pre-existing `workingDir` is safely verified to still belong
   * to `repoHash` (see `ensureWorkingDir`'s doc comment in
   * `FetchDistributionService`).
   */
  async stampRepoHash(transport: IServerTransport, workingDir: string, repoHash: string): Promise<void> {
    await execGitOrThrow(
      transport,
      `git -C ${shellQuote(workingDir)} config ${RemoteBundleOps.REPO_HASH_CONFIG_KEY} ${shellQuote(repoHash)} 2>&1`,
      5_000,
      'git config (repoHash stamp) failed',
    );
  }
}

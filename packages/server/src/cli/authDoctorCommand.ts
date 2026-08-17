import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { findAzitoctlEnvFiles } from '../shared/azitoctlEnv';
import { resolveCurrentUiToken } from '../shared/currentUiToken';
import { resolveScopedAuthEnabled } from '../shared/auth/scopedAuthFlag';
import { resolveDataDir } from '../shared/dataDir';
import { openDatabase } from '../shared/db/Database';
import { open } from '../shared/crypto/SecretBox';
import { TmuxClient } from '../modules/tmux/TmuxClient';
import { TransportFactory } from '../modules/servers/transport/TransportFactory';
import type { ServerConfig, MuxRuntime } from '../modules/servers/Server';

// ─── azito auth doctor (Issue #28 Phase B, design §12 step 1) ───
//
// Sanity check for the operator/task credential separation introduced by the
// harness distribution split (setup.sh no longer writes AZITO_UI_TOKEN into
// azitoctl*.env; --ui-token instead goes to a new operator.env that nothing
// auto-sources). Checks (a)-(d) and (f) below only read files/env on the
// machine this process runs on and have no notion of "the remote servers".
//
// Check (e) — the drain check — is the one exception (Issue #28 third-party
// review finding): it runs FROM the hub and inspects every server the hub's
// DB knows about (local AND agent) through that server's own transport, not
// just files on this machine. It therefore only produces a meaningful result
// when run on the machine holding the hub's DB; run anywhere else it reports
// itself as unable to check (see that function's own doc comment) rather
// than a false "the remote servers must be checked separately" green.

interface CheckResult {
  ok: boolean;
  label: string;
  detail: string;
  /**
   * True when this check couldn't actually verify anything (its
   * prerequisite tool/config is absent) rather than having verified
   * something and found it fine or broken. Rendered as its own marker
   * (`--`) instead of `OK`/`NG` and never fails the command — "we didn't
   * check" must stay visually distinct from "we checked and it's fine",
   * or a human reading a green `azito auth doctor` run would wrongly
   * believe the Codex MCP token was confirmed in sync with the hub.
   */
  notice?: boolean;
  /**
   * True when this check verified something and found a condition worth the
   * operator's attention, but not one that makes the current state broken —
   * distinct from `!ok` (NG, "this is currently wrong") and from `notice`
   * ("we couldn't check"). Rendered with its own `!!` marker and never flips
   * `process.exitCode` — a warning is advisory guidance (e.g. ahead of a
   * planned `AZITO_SCOPED_AUTH` migration step), not a doctor failure.
   */
  warning?: boolean;
}

function operatorEnvPath(): string {
  return path.join(process.env.HOME || '', '.azito', 'operator.env');
}

function mcpSettingsPath(): string {
  return path.join(process.env.HOME || '', '.claude', 'settings.json');
}

// (a) azitoctl*.env に AZITO_UI_TOKEN が残っていないか
//
// Third-party review Minor finding: `fs.readFileSync` here used to run
// unguarded — a file the process can't read (permission bits changed
// out-of-band) or a broken symlink (a stale target from a since-removed
// setup) threw straight out of the `.filter()` and crashed the ENTIRE
// `azito auth doctor` command, not just this one check, so a human never
// even saw the other three checks' results. Each file is now read
// independently inside try/catch, mirroring `readMcpUiToken`'s
// present/absent/unreadable split below: an unreadable file is reported as
// its own NG with repair guidance instead of aborting the whole command.
function checkAzitoctlEnvNoUiToken(): CheckResult {
  const label = 'azitoctl*.env に AZITO_UI_TOKEN が残っていない';
  const files = findAzitoctlEnvFiles();
  if (files.length === 0) {
    return { ok: true, label, detail: '~/.azito/azitoctl*.env が見つかりません（未セットアップ、または対象外）' };
  }

  const offenders: string[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      unreadable.push(`${file}（${err instanceof Error ? err.message : String(err)}）`);
      continue;
    }
    if (/^AZITO_UI_TOKEN=/m.test(content)) offenders.push(file);
  }

  if (offenders.length === 0 && unreadable.length === 0) {
    return { ok: true, label, detail: `確認済み: ${files.join(', ')}` };
  }

  const lines: string[] = [];
  if (offenders.length > 0) {
    lines.push(
      `AZITO_UI_TOKEN が残っています: ${offenders.join(', ')}`,
      '  修正: harness/setup.sh を（同じ --azito-url --webhook-token で）再実行してください。' +
      'このファイルは毎回丸ごと書き直されるため、UI トークン行は自動的に消えます。',
    );
  }
  if (unreadable.length > 0) {
    lines.push(
      `読み取りに失敗しました: ${unreadable.join(', ')}`,
      '  修正: ファイルのパーミッションを確認する（自分の所有か、読み取り権限があるか）か、' +
      'シンボリックリンクが壊れていないか確認してください。解決しない場合は harness/setup.sh を再実行して作り直してください。',
    );
  }
  return { ok: false, label, detail: lines.join('\n') };
}

// (b) operator.env のパーミッションが 0600 か
function checkOperatorEnvPermissions(): CheckResult {
  const label = 'operator.env のパーミッションが 0600';
  const filePath = operatorEnvPath();
  if (!fs.existsSync(filePath)) {
    return { ok: true, label, detail: `${filePath} は存在しません（--ui-token 未使用、または未セットアップ）` };
  }

  const mode = fs.statSync(filePath).mode & 0o777;
  if (mode === 0o600) {
    return { ok: true, label, detail: filePath };
  }
  return {
    ok: false,
    label,
    detail: `${filePath} のパーミッションが ${mode.toString(8)} です。\n  修正: chmod 600 ${filePath}`,
  };
}

interface McpSettingsFile {
  mcpServers?: Record<string, { env?: Record<string, string> }>;
}

// Issue #28 review Minor finding: a broken/unreadable settings.json used to
// be indistinguishable from "azt-mcp has no AZITO_UI_TOKEN configured" —
// both fell through the same `catch { return undefined; }` and `readMcpUiToken`
// resulted in `checkMcpTokenMatchesHub` reporting green (`ok: true`, "未設定
// なので問題ありません"). A human running `azito auth doctor` after editing
// settings.json by hand (or after a tool crashed mid-write) would see a
// clean pass and never learn the file was actually broken — the read/parse
// failure must surface as its own, independently-failing check with its own
// repair guidance, not be silently folded into the "not configured" case.
type McpUiTokenResult =
  | { status: 'absent' }
  | { status: 'unreadable'; error: string }
  | { status: 'present'; token: string };

function readMcpUiToken(settingsPath: string): McpUiTokenResult {
  if (!fs.existsSync(settingsPath)) return { status: 'absent' };
  let settings: McpSettingsFile;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as McpSettingsFile;
  } catch (err) {
    return { status: 'unreadable', error: err instanceof Error ? err.message : String(err) };
  }
  const token = settings.mcpServers?.['azt-mcp']?.env?.AZITO_UI_TOKEN;
  return token ? { status: 'present', token } : { status: 'absent' };
}

// (c) MCP settings の AZITO_UI_TOKEN がハブの現在値と一致するか
//     （ローカルで読める範囲 — resolveCurrentUiToken() と同じ解決順）
function checkMcpTokenMatchesHub(): CheckResult {
  const label = 'MCP settings の AZITO_UI_TOKEN がハブの現在値と一致';
  const settingsPath = mcpSettingsPath();
  const mcpTokenResult = readMcpUiToken(settingsPath);

  if (mcpTokenResult.status === 'unreadable') {
    return {
      ok: false,
      label,
      detail:
        `${settingsPath} の読み取りまたは JSON パースに失敗しました: ${mcpTokenResult.error}\n` +
        '  修正: ファイルの内容を確認し、壊れた JSON を修復してください' +
        '（バックアップから復元するか、azt-mcp の設定を再登録してください）。',
    };
  }

  if (mcpTokenResult.status === 'absent') {
    return {
      ok: true,
      label,
      detail: `${settingsPath} に azt-mcp の AZITO_UI_TOKEN が未設定です（このマシンから MCP を使わない場合は問題ありません）`,
    };
  }
  const mcpToken = mcpTokenResult.token;

  const current = resolveCurrentUiToken();
  if (!current) {
    return {
      ok: false,
      label,
      detail:
        'このマシンからハブの現在の UI トークンを読めませんでした' +
        '（AZITO_UI_TOKEN env / サーバー .env / data/ui-token のいずれも見つかりません）。' +
        'リモートハブの場合はハブが動いているサーバー上で doctor を実行してください。',
    };
  }

  if (mcpToken === current.token) {
    return { ok: true, label, detail: `${settingsPath}（一致元: ${current.source}）` };
  }
  return {
    ok: false,
    label,
    detail:
      `${settingsPath} の azt-mcp トークンとハブの現在値（一致元: ${current.source}）が不一致です。\n` +
      '  修正: azito token rotate 後の配布漏れの可能性があります。' +
      'harness/setup.sh --ui-token <token> を再実行するか、azito token rotate を再実行してください。',
  };
}

// (d) Codex 側の azt-mcp トークンがハブの現在値と一致するか
//
// setup.sh は `codex mcp add azt-mcp --env AZITO_UI_TOKEN=... -- node ...` で
// Codex CLI にも azt-mcp を登録するが、`azito token rotate` は意図的に
// Codex 側の登録を更新しない（同期先が増えるほど「rotate 後にどこかが
// 401 になる」経路が増えるため、rotate はトークンファイル + operator.env +
// Claude の MCP settings のみを更新し、それ以外は harness/setup.sh の
// 再配布に委ねる設計 — checkMcpTokenMatchesHub の Claude 側と同じ理由）。
// これまで doctor は Claude 側の MCP 設定しか見ていなかったため、Codex を
// 使っている環境では「doctor が green でも Codex の azt-mcp は旧トークンの
// まま」というドリフトを検出できなかった。
//
// `codex` CLI 自体が入っていない環境（Codex を使わない開発者・サーバー）は
// 「確認不能」であって「壊れている」わけではないので、NG にはせず notice
// として報告する。
// `codex mcp get <name> --json` prints this exact message to stderr (and
// exits non-zero) when the named MCP server isn't registered at all —
// confirmed against codex-cli 0.146.0. Only this specific shape means
// "nothing to check"; any other non-zero exit (timeout, permission error,
// corrupted `~/.codex/config.toml`, etc.) is a real failure we can't verify
// through, not an absence, and must not be reported as green.
const CODEX_MCP_NOT_REGISTERED_RE = /no mcp server named/i;

function checkCodexMcpTokenMatchesHub(): CheckResult {
  const label = 'Codex MCP settings の azt-mcp トークンがハブの現在値と一致';

  let stdout: string;
  try {
    stdout = execFileSync('codex', ['mcp', 'get', 'azt-mcp', '--json'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number; stderr?: string; stdout?: string };
    if (e.code === 'ENOENT') {
      return {
        ok: true,
        notice: true,
        label,
        detail: 'codex コマンドが見つかりません（Codex を使わない環境では確認不能・問題ありません）',
      };
    }

    const combinedOutput = `${e.stderr ?? ''}\n${e.stdout ?? ''}`;
    if (CODEX_MCP_NOT_REGISTERED_RE.test(combinedOutput)) {
      // `codex mcp get` exits non-zero specifically because azt-mcp isn't
      // registered in Codex at all — that's "nothing to check", the same
      // "not configured" treatment `checkMcpTokenMatchesHub` gives an absent
      // Claude entry, not a doctor failure.
      return {
        ok: true,
        label,
        detail: 'Codex に azt-mcp が登録されていません（このマシンで Codex を使わない場合は問題ありません）',
      };
    }

    // Any other failure (timeout, permission error, corrupted config, an
    // unrecognized CLI error shape) is genuinely "we couldn't verify this" —
    // rounding it down to green would hide a real problem behind a clean
    // `azito auth doctor` run. Report as notice (not NG, since it's not a
    // confirmed mismatch either) with the original error attached.
    const message = e.stderr?.trim() || (err instanceof Error ? err.message : String(err));
    return {
      ok: true,
      notice: true,
      label,
      detail:
        `codex mcp get azt-mcp --json の実行に失敗し、登録状況を確認できませんでした: ${message}\n` +
        '  修正: `codex mcp get azt-mcp --json` を手動で実行して原因を確認してください' +
        '（タイムアウト・権限エラー・設定ファイル破損などが考えられます）。',
    };
  }

  let parsed: { transport?: { env?: Record<string, string> } };
  try {
    parsed = JSON.parse(stdout) as { transport?: { env?: Record<string, string> } };
  } catch (err) {
    return {
      ok: false,
      label,
      detail:
        `codex mcp get azt-mcp --json の出力の JSON パースに失敗しました: ${err instanceof Error ? err.message : String(err)}\n` +
        '  修正: `codex mcp get azt-mcp --json` を手動で実行して出力を確認してください。',
    };
  }
  const codexToken = parsed.transport?.env?.AZITO_UI_TOKEN;
  if (!codexToken) {
    return {
      ok: true,
      label,
      detail: 'Codex 側の azt-mcp に AZITO_UI_TOKEN が未設定です（このマシンから Codex 経由で MCP を使わない場合は問題ありません）',
    };
  }

  const current = resolveCurrentUiToken();
  if (!current) {
    return {
      ok: false,
      label,
      detail:
        'このマシンからハブの現在の UI トークンを読めませんでした' +
        '（AZITO_UI_TOKEN env / サーバー .env / data/ui-token のいずれも見つかりません）。' +
        'リモートハブの場合はハブが動いているサーバー上で doctor を実行してください。',
    };
  }

  if (codexToken === current.token) {
    return { ok: true, label, detail: `codex mcp get azt-mcp（一致元: ${current.source}）` };
  }
  return {
    ok: false,
    label,
    detail:
      `Codex 側の azt-mcp トークンとハブの現在値（一致元: ${current.source}）が不一致です。\n` +
      '  修正: `azito token rotate` は Codex の登録を更新しません。' +
      'harness/setup.sh --ui-token <token> を再実行して Codex 側の azt-mcp を更新してください。',
  };
}

// (e) scoped 有効化前の生存タスク所有ウィンドウ検査
//
// Design v3 §12's migration procedure calls for draining (finishing or
// recreating) task windows before flipping AZITO_SCOPED_AUTH on — a window
// created in compat mode keeps AZITO_UI_TOKEN in its pane environment for
// its whole lifetime, so a still-live task pane created before the flag was
// enabled can keep acting as an operator-equivalent principal even after
// the flag flips (nothing re-derives its env from the new mode on the fly).
// There was no way to actually VERIFY the drain step happened, though — a
// human just had to trust they remembered to finish every task first. This
// check makes that concrete: while AZITO_SCOPED_AUTH is still off, look for
// task-owned windows whose tmux pane is still alive.
//
// Issue #28 third-party review finding (Important): this used to run its
// query scoped to `type = 'local'` only, and its own guidance then told a
// human to re-run the SAME command "on each server" to cover the rest — but
// only the hub process has this SQLite DB at all (a remote `agent` server's
// process has no `servers`/`windows` tables to query), so that instruction
// was unsatisfiable and every non-local task window went unchecked forever
// while still being reported as a clean/green drain. This now runs FROM the
// hub, over every server the hub's DB knows about (any `type`), driving each
// one through its own transport (`TmuxClient.checkPaneLiveness` — local via
// `execFile`, `agent` via HTTP to that server's agent process). A server
// this process cannot currently reach — down, wrong token, network partition
// — is reported as `notice` (unverifiable), NEVER folded into a green
// result: "we couldn't check" must stay visibly different from "we checked
// and it's clean," or a human reading this report would trust a clean run
// that in fact never looked at that server at all.
//
// A live pane is a `warning`, not an NG: while the flag is off, a live task
// window is completely normal/expected, not evidence of anything already
// broken. It only matters as pre-flight guidance for someone about to flip
// the flag on. Once AZITO_SCOPED_AUTH is actually enabled, this check is a
// no-op (skipped) — draining is a one-time migration step, not an ongoing
// invariant this command should keep flagging.
async function checkTaskOwnedWindowsBeforeScopedAuth(): Promise<CheckResult> {
  const label = 'scoped 認可 有効化前の生存タスクウィンドウ（ハブから全サーバーを検査）';

  if (resolveScopedAuthEnabled()) {
    return {
      ok: true,
      label,
      detail: 'AZITO_SCOPED_AUTH が既に有効です（この検査は未有効時のみ対象）',
    };
  }

  const paths = resolveDataDir();
  if (!fs.existsSync(paths.db)) {
    // Third-party review finding: this check can only ever run meaningfully
    // on the machine holding the hub's DB — there is nothing to do "per
    // server" here, unlike the old guidance implied. A human running this on
    // a remote server (which has no hub DB at all) must be redirected to the
    // hub, not told a false "nothing to check" green.
    return {
      ok: true,
      notice: true,
      label,
      detail:
        `${paths.db} が見つかりません。このホストはハブではありません（ハブの DB を持つホストでのみ検査できます）。\n` +
        '  案内: ハブが動いているサーバー上で `azito auth doctor` を実行してください。',
    };
  }

  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(paths.db);

    const taskWindows = db
      .prepare("SELECT task_id AS taskId, server_name AS serverName, tmux_target AS tmuxTarget FROM windows WHERE owner_type = 'task'")
      .all() as { taskId: number; serverName: string; tmuxTarget: string }[];
    if (taskWindows.length === 0) {
      return { ok: true, label, detail: 'タスク所有ウィンドウの登録がありません（ハブ管理下の全サーバー）' };
    }

    const serverRowStmt = db.prepare(
      'SELECT name, type, host, agent_port, agent_token, agent_version, ssh_host, mux_runtime, ssh_host_fingerprint, created_at FROM servers WHERE name = ?',
    );
    // Fix 1 (Issue #28 third-party review, Important): `open()` throws both
    // when SecretBox hasn't been initialized at all AND when a given
    // server's `agent_token` fails to decrypt (corrupted ciphertext, master
    // key rotated/lost without re-encrypting existing rows, etc). Either
    // way, one bad row must not take down the whole doctor run — it's
    // reported as "unverifiable" for that server (same bucket as an
    // unreachable server below), and every other server/check still runs.
    const serverConfigCache = new Map<string, ServerConfig | null>();
    const serverDecryptFailures = new Map<string, string>();
    function resolveServerConfig(serverName: string): ServerConfig | null {
      if (serverConfigCache.has(serverName)) return serverConfigCache.get(serverName)!;
      const row = serverRowStmt.get(serverName) as Record<string, unknown> | undefined;
      if (!row) {
        serverConfigCache.set(serverName, null);
        return null;
      }
      let agentToken: string | null;
      try {
        agentToken = open(row.agent_token as string | null);
      } catch (err) {
        serverDecryptFailures.set(serverName, err instanceof Error ? err.message : String(err));
        serverConfigCache.set(serverName, null);
        return null;
      }
      const config: ServerConfig = {
        name: row.name as string,
        type: row.type as ServerConfig['type'],
        host: (row.host as string) ?? null,
        agentPort: (row.agent_port as number) ?? null,
        agentToken,
        agentVersion: (row.agent_version as string) ?? null,
        sshHost: (row.ssh_host as string) ?? null,
        muxRuntime: (row.mux_runtime as MuxRuntime) ?? 'system',
        sshHostFingerprint: (row.ssh_host_fingerprint as string) ?? null,
        createdAt: row.created_at as string,
      };
      serverConfigCache.set(serverName, config);
      return config;
    }

    const tmux = new TmuxClient(new TransportFactory(''), '', '', '');

    const alive: string[] = [];
    const unverifiable: string[] = [];
    for (const w of taskWindows) {
      const descriptor = `task #${w.taskId}（${w.serverName}:${w.tmuxTarget}）`;
      const config = resolveServerConfig(w.serverName);
      if (!config) {
        const decryptError = serverDecryptFailures.get(w.serverName);
        // The window row either references a server that's no longer
        // registered (stale data), or its agent_token failed to decrypt
        // (corrupted ciphertext / master key mismatch) — either way there's
        // no transport we can drive to check this pane.
        unverifiable.push(
          decryptError
            ? `${descriptor}（サーバー設定の復号に失敗: ${decryptError}）`
            : `${descriptor}（サーバー未登録）`,
        );
        continue;
      }
      const { alive: isAlive, verified } = await tmux.checkPaneLiveness(config, w.tmuxTarget);
      if (!verified) {
        unverifiable.push(`${descriptor}（到達不能）`);
      } else if (isAlive) {
        alive.push(descriptor);
      }
    }

    if (alive.length === 0 && unverifiable.length === 0) {
      return {
        ok: true,
        label,
        detail: 'タスク所有ウィンドウの登録はありますが、生存中の tmux ペインはありません（全サーバーで確認済み）',
      };
    }

    if (alive.length === 0) {
      return {
        ok: true,
        notice: true,
        label,
        detail:
          `検査できないサーバー上にタスク所有ウィンドウが ${unverifiable.length} 件あります（未登録サーバー参照、または到達不能）: ${unverifiable.join(', ')}\n` +
          '  案内: 対象サーバーが起動している／agent に到達可能であることを確認してから再実行してください。' +
          'この件数は clean（green）としてではなく「未確認」として扱ってください。',
      };
    }

    const lines = [
      `生存中のタスク所有ウィンドウが ${alive.length} 件見つかりました: ${alive.join(', ')}`,
      '  案内: scoped 有効化前に、これらのタスクを終端させるか再生成してください。' +
        '互換モードで作られたペインは env に AZITO_UI_TOKEN を保持したまま残るため、' +
        '有効化後も残存ペインが operator 相当として振る舞える可能性があります。',
      '  有効化後に `azito token rotate` を実行すると、残存 env のトークンも最終的に無効化されます' +
        '（最後の rotate が実質的なドレインの仕上げを兼ねます）。',
    ];
    if (unverifiable.length > 0) {
      lines.push(
        `  検査できなかったタスク所有ウィンドウも ${unverifiable.length} 件あります（未確認 — clean とはみなさないでください）: ${unverifiable.join(', ')}`,
      );
    }
    return { ok: true, warning: true, label, detail: lines.join('\n') };
  } finally {
    db?.close();
  }
}

// (f) AZITO_SCOPED_AUTH の現在値
function checkScopedAuthFlag(): CheckResult {
  const enabled = resolveScopedAuthEnabled();
  return {
    ok: true,
    label: 'AZITO_SCOPED_AUTH の現在値',
    detail: enabled
      ? '1 (scoped 認可: 有効 — task principal は allowlist 済み API のみアクセス可能)'
      : '未設定 (互換モード: task principal も operator 相当の操作が可能)',
  };
}

function colorize(ok: boolean, text: string): string {
  if (!process.stdout.isTTY) return text;
  const code = ok ? '32' : '31'; // green / red
  return `\x1b[${code}m${text}\x1b[0m`;
}

export async function authDoctorCommand(): Promise<void> {
  console.log('azito auth doctor');
  console.log('多くの検査はこのマシンのローカルファイルのみが対象です。タスクウィンドウの生存検査（e）だけはハブから全サーバーを横断検査します — ハブ以外のホストで実行した場合はその旨を案内します。\n');

  const checks: CheckResult[] = [
    checkAzitoctlEnvNoUiToken(),
    checkOperatorEnvPermissions(),
    checkMcpTokenMatchesHub(),
    checkCodexMcpTokenMatchesHub(),
    await checkTaskOwnedWindowsBeforeScopedAuth(),
    checkScopedAuthFlag(),
  ];

  // Fix (Phase C round-4 review, Minor): `hasFailure` used to be the only
  // thing this loop tallied, so a run with nothing but `warning`/`notice`
  // entries (leftover legacy panes, an unreachable server, a `codex` CLI
  // this doctor couldn't verify) still printed "すべての検査に合格しました"
  // and exited 0 — indistinguishable from a run where every check actually
  // verified something and found it clean. That made this command unusable
  // as a migration gate in automation: a script polling for "green" would
  // proceed past an unfinished drain or an unreachable server it never
  // actually confirmed. `hasWarning`/`hasNotice` are tallied separately so
  // the summary — and `process.exitCode` — can distinguish all four states:
  // clean (every check verified something and it's fine), failure (`ok:
  // false`, exit 1, unchanged from before), warning (advisory, nothing
  // currently broken but action recommended, exit 2), and unverifiable
  // (couldn't check at least one thing, exit 3). Only the clean state may
  // report "すべての検査に合格しました" / exit 0 — warning and
  // unverifiable are each reported with their own message and exit code so
  // neither can be mistaken for "all checks passed".
  let hasFailure = false;
  let hasWarning = false;
  let hasNotice = false;
  for (const check of checks) {
    const mark = check.notice
      ? (process.stdout.isTTY ? '\x1b[33m-- \x1b[0m' : '-- ')
      : check.warning
        ? (process.stdout.isTTY ? '\x1b[33m!! \x1b[0m' : '!! ')
        : colorize(check.ok, check.ok ? 'OK ' : 'NG ');
    console.log(`[${mark}] ${check.label}`);
    for (const line of check.detail.split('\n')) {
      console.log(`      ${line}`);
    }
    if (!check.ok) hasFailure = true;
    if (check.warning) hasWarning = true;
    if (check.notice) hasNotice = true;
  }

  console.log('');
  if (hasFailure) {
    console.log(colorize(false, '一部の検査に失敗しました。上記の修正手順に従ってください。'));
    process.exitCode = 1;
  } else if (hasWarning) {
    console.log(colorize(false, '失敗はありませんが、対応を推奨する warning があります。上記の案内を確認してください。'));
    process.exitCode = 2;
  } else if (hasNotice) {
    console.log(colorize(false, '失敗はありませんが、確認できなかった項目があります（unverifiable）。上記の案内に従って再確認してください。'));
    process.exitCode = 3;
  } else {
    console.log(colorize(true, 'すべての検査に合格しました。'));
  }
}

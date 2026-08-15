import type { IServerTransport } from './transport/ServerTransport';
import { shellQuote } from '../../shared/shellQuote';
import { isAzitoctlEnvFilename } from '../../shared/azitoctlEnv';
import { extractClaudeMcpUiToken, hasCodexConfigUiToken } from '../../shared/mcpTokenStores';

// ─── Isolation doctor (Issue #29 Step 2 B) ───
//
// Layer 2 ("検証") of the isolation profile design: where `isolationIntent`
// (Server.ts) is a DECLARATION the operator makes and layer 3
// (TaskPaneEnvironmentService / HarnessInstaller) enforces credential
// withholding on unconditionally, this module actually PROBES a live
// `agent`-type server for evidence that no operator-equivalent credential
// is reachable there. It never influences layer 3's decisions (declared
// intent alone still gates credential distribution — see Server.ts's
// isolationIntent doc comment); it only produces a report an operator (and
// the frontend) can read.
//
// Every check below is a SNAPSHOT taken at probe time, not a continuous
// guarantee — a credential could be written to the server the moment after
// a passing probe returns (TOCTOU). This module cannot close that gap; only
// re-running the probe (or a future execute-time re-verification, out of
// scope for this step) can. Callers must present `verified`/`isolationVerifiedAt`
// to operators as "as of this check", never as an ongoing promise.
//
// Fail-closed contract: a check that could not actually be verified (the
// prerequisite command/tool is unreachable, or its output was in an
// unrecognized shape) reports `'unknown'`, NEVER folded into `'pass'`. The
// overall `verified` flag is true only when EVERY check is `'pass'` — a
// single `'unknown'` or `'fail'` anywhere blocks it, matching the isolation
// gate's own "unable to prove clean means fail closed" philosophy
// (servers/routes.ts's checkIsolationBlockers).

export type IsolationCheckStatus = 'pass' | 'fail' | 'unknown';

export interface IsolationCheck {
  id: string;
  status: IsolationCheckStatus;
  detail: string;
}

export interface IsolationDoctorResult {
  verified: boolean;
  checks: IsolationCheck[];
}

/** Hub-side identity resolved ONCE at the route boundary (Resolve at the
 * Boundary — main.ts/routes.ts owns process.env/os access, this module only
 * ever receives already-resolved values) and passed in, never re-read here. */
export interface HubIdentity {
  hostname: string;
  uid: number | null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 1. Same-host detection: an `agent` server whose hostname AND uid both
 * match the hub process's own is, for credential-storage purposes,
 * indistinguishable from the hub itself — any "isolation" declared for it
 * would be a label with no actual separation behind it. Fails only when
 * BOTH match (that combination is the same process-identity signal the hub
 * would see if this "remote" server were actually itself).
 *
 * Review finding (Step 2 review, Important #3): hostname alone is NOT an FS
 * isolation boundary — two containers sharing a Docker host's utsname can
 * still differ, and a uid-matching container bind-mounting the hub's own
 * data directory would pass a "both differ" test while sharing real
 * filesystem access. Neither a hostname match nor a uid match ALONE proves
 * anything about shared credential storage either way (a shared hostname
 * alone doesn't prove a shared FS; two independent hosts both defaulting to
 * uid 1000 doesn't either) — this check cannot independently verify FS
 * separation, so EITHER one matching alone is now `'unknown'` (inconclusive),
 * not `'pass'`. Only "neither matches" is treated as positive evidence of
 * separation; only "both match" is treated as positive evidence AGAINST it.
 */
async function checkSameHost(transport: IServerTransport, hub: HubIdentity): Promise<IsolationCheck> {
  const id = 'same_host';
  let result;
  try {
    result = await transport.exec('hostname; id -u');
  } catch (err) {
    return { id, status: 'unknown', detail: `hostname/uid の取得に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (result.code !== 0) {
    return { id, status: 'unknown', detail: `hostname/uid の取得に失敗しました (code ${result.code}): ${result.stderr || result.stdout || '(no output)'}` };
  }
  const lines = result.stdout.split('\n').map((l) => l.trim());
  const remoteHostname = lines[0] ?? '';
  const remoteUidStr = lines[1] ?? '';
  const remoteUid = /^\d+$/.test(remoteUidStr) ? Number(remoteUidStr) : null;
  if (!remoteHostname || remoteUid === null) {
    return { id, status: 'unknown', detail: `hostname/uid の出力が想定外の形式でした: ${JSON.stringify(result.stdout)}` };
  }
  if (hub.uid === null) {
    return { id, status: 'unknown', detail: 'ハブ側の uid を取得できなかったため、同一ホスト判定ができません（process.getuid が利用不可）' };
  }
  const sameHostname = remoteHostname === hub.hostname;
  const sameUid = remoteUid === hub.uid;
  if (sameHostname && sameUid) {
    return { id, status: 'fail', detail: `agent サーバーの hostname/uid（${remoteHostname}/${remoteUid}）がハブ自身（${hub.hostname}/${hub.uid}）と同一です` };
  }
  if (sameHostname || sameUid) {
    return {
      id,
      status: 'unknown',
      detail:
        `agent: ${remoteHostname}/${remoteUid}、hub: ${hub.hostname}/${hub.uid}（hostname/uid の一方のみ一致 — ` +
        'ファイルシステム分離を独立に確認できないため判定不能です）',
    };
  }
  return { id, status: 'pass', detail: `agent: ${remoteHostname}/${remoteUid}、hub: ${hub.hostname}/${hub.uid}（一致しません）` };
}

/**
 * 2. `~/.ssh` に秘密鍵が無い — `PRIVATE KEY` ヘッダ走査。ディレクトリ自体が
 * 存在しない場合は自明に pass（走査対象がない）。
 */
async function checkNoPrivateKeys(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_ssh_private_keys';
  const cmd = 'if [ -d "$HOME/.ssh" ]; then grep -rIl "PRIVATE KEY" "$HOME/.ssh" 2>/dev/null; echo AZT_SSH_DIR_EXISTS; else echo AZT_SSH_NO_DIR; fi';
  let result;
  try {
    result = await transport.exec(cmd);
  } catch (err) {
    return { id, status: 'unknown', detail: `~/.ssh の走査に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (result.code !== 0) {
    return { id, status: 'unknown', detail: `~/.ssh の走査に失敗しました (code ${result.code}): ${result.stderr || result.stdout || '(no output)'}` };
  }
  const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.includes('AZT_SSH_NO_DIR')) {
    return { id, status: 'pass', detail: '~/.ssh ディレクトリが存在しません' };
  }
  if (!lines.includes('AZT_SSH_DIR_EXISTS')) {
    return { id, status: 'unknown', detail: `~/.ssh の走査結果が想定外の形式でした: ${JSON.stringify(result.stdout)}` };
  }
  const offenders = lines.filter((l) => l !== 'AZT_SSH_DIR_EXISTS');
  if (offenders.length > 0) {
    return { id, status: 'fail', detail: `秘密鍵らしきファイルが見つかりました: ${offenders.join(', ')}` };
  }
  return { id, status: 'pass', detail: '~/.ssh 配下に秘密鍵は見つかりませんでした' };
}

/** 3. `gh auth status` が未認証または gh 不在。 */
async function checkGhUnauthenticated(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'gh_unauthenticated';
  const cmd = 'if command -v gh >/dev/null 2>&1; then gh auth status >/dev/null 2>&1; echo "AZT_GH_EXIT:$?"; else echo AZT_GH_ABSENT; fi';
  let result;
  try {
    result = await transport.exec(cmd);
  } catch (err) {
    return { id, status: 'unknown', detail: `gh の確認に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (result.code !== 0) {
    return { id, status: 'unknown', detail: `gh の確認に失敗しました (code ${result.code}): ${result.stderr || result.stdout || '(no output)'}` };
  }
  const content = result.stdout.trim();
  if (content === 'AZT_GH_ABSENT') {
    return { id, status: 'pass', detail: 'gh コマンドが見つかりません' };
  }
  const match = /^AZT_GH_EXIT:(\d+)$/m.exec(content);
  if (!match) {
    return { id, status: 'unknown', detail: `gh auth status の結果が想定外の形式でした: ${JSON.stringify(content)}` };
  }
  const exitCode = Number(match[1]);
  if (exitCode === 0) {
    return { id, status: 'fail', detail: 'gh が認証済みです（gh auth status が成功）' };
  }
  return { id, status: 'pass', detail: `gh は未認証です（gh auth status exit ${exitCode}）` };
}

/** 4. git credential helper が空・`~/.git-credentials` が不在。 */
async function checkNoGitCredentials(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_git_credentials';
  const cmd = 'git config --global --get credential.helper 2>/dev/null; echo AZT_HELPER_END; '
    + 'test -f "$HOME/.git-credentials" && echo AZT_CREDFILE_EXISTS || echo AZT_CREDFILE_ABSENT';
  let result;
  try {
    result = await transport.exec(cmd);
  } catch (err) {
    return { id, status: 'unknown', detail: `git credential 設定の確認に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (result.code !== 0) {
    return { id, status: 'unknown', detail: `git credential 設定の確認に失敗しました (code ${result.code}): ${result.stderr || result.stdout || '(no output)'}` };
  }
  const lines = result.stdout.split('\n');
  const helperEndIdx = lines.findIndex((l) => l.trim() === 'AZT_HELPER_END');
  if (helperEndIdx === -1) {
    return { id, status: 'unknown', detail: `git credential 設定の確認結果が想定外の形式でした: ${JSON.stringify(result.stdout)}` };
  }
  const helper = lines.slice(0, helperEndIdx).join('\n').trim();
  const rest = lines.slice(helperEndIdx + 1).join('\n');
  const credFileExists = rest.includes('AZT_CREDFILE_EXISTS');
  const credFileAbsent = rest.includes('AZT_CREDFILE_ABSENT');
  if (!credFileExists && !credFileAbsent) {
    return { id, status: 'unknown', detail: `~/.git-credentials の有無を確認できませんでした: ${JSON.stringify(rest)}` };
  }
  if (helper === '' && !credFileExists) {
    return { id, status: 'pass', detail: 'credential.helper 未設定、~/.git-credentials も不在です' };
  }
  const reasons: string[] = [];
  // Review finding (Step 2 review, Important #4): `helper`'s raw value is a
  // shell command string (`credential.helper` can be `!<command>`, e.g.
  // `!aws codecommit credential-helper $@`, or `store --file
  // /path/with/user:pass@host`) that can itself embed a username/password/
  // token. It must never reach `detail` verbatim — this report is persisted
  // to `isolation_report`, surfaced through the audit log, and rendered in
  // the browser (see routes.ts's POST .../isolation/doctor and
  // OverviewSection.tsx). Only classify the helper into a coarse shape
  // (never the value itself) so a human still learns SOMETHING actionable
  // ("a helper is configured, here's roughly what kind") without leaking
  // its contents.
  if (helper !== '') reasons.push(`credential.helper が設定されています（種別: ${classifyGitCredentialHelper(helper)}）`);
  if (credFileExists) reasons.push('~/.git-credentials が存在します');
  return { id, status: 'fail', detail: reasons.join(' / ') };
}

/**
 * Coarse, value-free classification of a `credential.helper` setting for
 * report/audit-log display — never returns any substring of `helper` itself
 * (see checkNoGitCredentials's redaction comment above).
 */
function classifyGitCredentialHelper(helper: string): string {
  if (helper.startsWith('!')) return 'shell command (!...)';
  const first = helper.trim().split(/\s+/)[0] ?? '';
  const base = first.split('/').pop() || first;
  switch (base) {
    case 'store': return 'store';
    case 'cache': return 'cache';
    case 'osxkeychain': return 'osxkeychain';
    case 'manager': return 'manager';
    case 'manager-core': return 'manager-core';
    case 'libsecret': return 'libsecret';
    default: return 'other';
  }
}

/**
 * 5. `~/.azito/` の設定に operator トークンが無い — Issue #28
 * `azitoctlEnv.ts` の発見文法（`isAzitoctlEnvFilename` / `hasUiTokenLine`）
 * を再利用し、azitoctl*.env に `AZITO_UI_TOKEN=` 行が残っていないこと、
 * operator.env が存在しないことを確認する（`authDoctorCommand.ts`
 * checkAzitoctlEnvNoUiToken / checkOperatorEnvPermissions と同じ判定基準—
 * 再利用するのは検査の"定義"であって、この関数自体は独立した実行器: あちらは
 * ローカル fs、こちらは agent サーバーへの transport 経由）。
 *
 * 6. ハブの data ディレクトリ・DB ファイルへの実アクセス不能 — 現状は
 * checkSameHost の hostname/uid シグナルに委ねている（Step 2 review,
 * Important #3 で "hostname/uid が違えば FS 到達不能" という過大な主張は
 * checkSameHost 側から削除済み: 一方のみ一致は今や unknown 判定になり、
 * 両方一致のみ fail）。ハブの data ディレクトリ/DB ファイルへの実アクセスを
 * 非機密カナリアで直接検証する独立チェック（例: ハブが書いた既知の無害
 * マーカーファイルの有無を transport 経由で確認）は本ラウンドでは未実装 —
 * 採用しない理由: そのカナリアファイルの配置・命名・ライフサイクル管理には
 * ハブ起動時の書き込み経路が新たに必要で、layer 2 の検証範囲を超える設計
 * 変更になるため、hostname/uid シグナルの保守的な扱い（一方一致は unknown）
 * で当面代替する。
 */
async function checkNoOperatorToken(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_operator_token';
  let homeResult;
  try {
    homeResult = await transport.exec('echo "$HOME"');
  } catch (err) {
    return { id, status: 'unknown', detail: `$HOME の解決に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  const remoteHome = homeResult.stdout.trim();
  if (homeResult.code !== 0 || !remoteHome) {
    return { id, status: 'unknown', detail: `$HOME の解決に失敗しました (code ${homeResult.code}): ${homeResult.stderr || homeResult.stdout || '(no output)'}` };
  }

  const azitoDir = `${remoteHome}/.azito`;
  let listResult;
  try {
    listResult = await transport.exec(`ls -1 ${shellQuote(azitoDir)} 2>/dev/null; echo AZT_LS_DONE`);
  } catch (err) {
    return { id, status: 'unknown', detail: `~/.azito の一覧取得に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (listResult.code !== 0) {
    return { id, status: 'unknown', detail: `~/.azito の一覧取得に失敗しました (code ${listResult.code}): ${listResult.stderr || listResult.stdout || '(no output)'}` };
  }
  const lines = listResult.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const doneIdx = lines.indexOf('AZT_LS_DONE');
  if (doneIdx === -1) {
    return { id, status: 'unknown', detail: `~/.azito の一覧取得結果が想定外の形式でした: ${JSON.stringify(listResult.stdout)}` };
  }
  const entries = lines.slice(0, doneIdx);
  const targets = entries.filter((name) => isAzitoctlEnvFilename(name) || name === 'operator.env');
  if (targets.length === 0) {
    return { id, status: 'pass', detail: '~/.azito に azitoctl*.env / operator.env が存在しません' };
  }

  // Each candidate name is validated (regex / exact literal) above, but is
  // still attacker-influenced data from a remote `ls` — never interpolated
  // into the shell command directly. Read via numeric markers instead of
  // embedding the filename in the echoed marker text, and quote every path
  // through shellQuote (single-quote escaping handles arbitrary content).
  const catCmd = targets
    .map((name, i) => `echo AZT_FILE_BEGIN:${i}; cat ${shellQuote(`${azitoDir}/${name}`)} 2>/dev/null; echo AZT_FILE_END:${i}`)
    .join('; ');
  let catResult;
  try {
    catResult = await transport.exec(catCmd);
  } catch (err) {
    return { id, status: 'unknown', detail: `azitoctl*.env / operator.env の内容取得に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (catResult.code !== 0) {
    return { id, status: 'unknown', detail: `azitoctl*.env / operator.env の内容取得に失敗しました (code ${catResult.code}): ${catResult.stderr || '(no output)'}` };
  }

  const offenders: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const beginMarker = `AZT_FILE_BEGIN:${i}`;
    const endMarker = `AZT_FILE_END:${i}`;
    const beginIdx = catResult.stdout.indexOf(beginMarker);
    const endIdx = catResult.stdout.indexOf(endMarker);
    if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
      return { id, status: 'unknown', detail: `${targets[i]} の内容取得結果が想定外の形式でした` };
    }
    const content = catResult.stdout.slice(beginIdx + beginMarker.length, endIdx);
    // operator.env carries AZITO_UI_TOKEN=... on the same line grammar
    // azitoctl*.env would if it were ever misconfigured — the same
    // predicate this doctor is already borrowing (see the doc comment
    // above) applies verbatim to both file kinds.
    if (/^AZITO_UI_TOKEN=/m.test(content)) {
      offenders.push(targets[i]);
    }
  }
  if (offenders.length > 0) {
    return { id, status: 'fail', detail: `AZITO_UI_TOKEN が残っているファイルがあります: ${offenders.join(', ')}` };
  }
  return { id, status: 'pass', detail: `確認済み: ${targets.join(', ')}` };
}

// Shared marker-fetch helper for the two checks below (7, 8): "read one
// file's content if it exists, or report its absence", via begin/end
// markers so multi-line file content (JSON, TOML) can be extracted without
// relying on splitting the whole output into lines (a technique already
// used by checkNoOperatorToken above). `$HOME`/`$CODEX_HOME` are expanded
// SHELL-SIDE (not interpolated by this TypeScript code), so there is no
// injection surface here — unlike the ls-derived filenames
// checkNoOperatorToken quotes, nothing attacker-influenced ever reaches the
// command string.
type FileProbeResult =
  | { kind: 'absent' }
  | { kind: 'content'; content: string }
  | { kind: 'unrecognized' };

async function probeFile(transport: IServerTransport, pathExpr: string): Promise<{ ok: true; probe: FileProbeResult } | { ok: false; detail: string }> {
  const cmd = `F="${pathExpr}"; if [ -f "$F" ]; then echo AZT_FILE_BEGIN; cat "$F"; echo AZT_FILE_END; else echo AZT_FILE_ABSENT; fi`;
  let result;
  try {
    result = await transport.exec(cmd);
  } catch (err) {
    return { ok: false, detail: `ファイルの取得に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (result.code !== 0) {
    return { ok: false, detail: `ファイルの取得に失敗しました (code ${result.code}): ${result.stderr || result.stdout || '(no output)'}` };
  }
  if (result.stdout.includes('AZT_FILE_ABSENT')) {
    return { ok: true, probe: { kind: 'absent' } };
  }
  const beginIdx = result.stdout.indexOf('AZT_FILE_BEGIN');
  const endIdx = result.stdout.indexOf('AZT_FILE_END');
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    return { ok: true, probe: { kind: 'unrecognized' } };
  }
  const content = result.stdout.slice(beginIdx + 'AZT_FILE_BEGIN'.length, endIdx);
  return { ok: true, probe: { kind: 'content', content } };
}

/**
 * 7. Claude の `~/.claude/settings.json` の MCP env に AZITO_UI_TOKEN が
 * 残っていない — `harness/setup.sh --purge-operator-token` が掃除する対象の
 * ひとつ（checkNoOperatorToken の doc comment、および
 * `shared/mcpTokenStores.ts` の doc comment を参照）。cleanup が対象とする
 * 全ストアを doctor が検査していなかった Step 2 review の Critical 指摘を
 * 埋める2チェックのうちの1つ。判定ロジック（`extractClaudeMcpUiToken`）は
 * `azito auth doctor`（authDoctorCommand.ts の readMcpUiToken）と共有。
 */
async function checkNoClaudeMcpToken(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_claude_mcp_token';
  const probed = await probeFile(transport, '$HOME/.claude/settings.json');
  if (!probed.ok) return { id, status: 'unknown', detail: `Claude settings.json の${probed.detail}` };
  const { probe } = probed;
  if (probe.kind === 'absent') {
    return { id, status: 'pass', detail: '~/.claude/settings.json が存在しません' };
  }
  if (probe.kind === 'unrecognized') {
    return { id, status: 'unknown', detail: '~/.claude/settings.json の取得結果が想定外の形式でした' };
  }
  const extraction = extractClaudeMcpUiToken(probe.content);
  if (extraction.status === 'unreadable') {
    return { id, status: 'unknown', detail: `~/.claude/settings.json の JSON パースに失敗しました: ${extraction.error}` };
  }
  if (extraction.status === 'present') {
    return { id, status: 'fail', detail: '~/.claude/settings.json の mcpServers.azt-mcp.env に AZITO_UI_TOKEN が残っています' };
  }
  return { id, status: 'pass', detail: '~/.claude/settings.json に azt-mcp の AZITO_UI_TOKEN はありません' };
}

/**
 * 8. Codex の `config.toml`（`$CODEX_HOME` または `~/.codex`）の
 * `mcp_servers.azt-mcp` env に AZITO_UI_TOKEN が残っていない — 7 と同じ
 * cleanup 対象漏れを埋めるチェック。判定は `hasCodexConfigUiToken`
 * （`shared/mcpTokenStores.ts`）— `harness/setup.sh`
 * `strip_codex_ui_token()` 自身が最終防衛線として使っている保守的な
 * bare-substring スキャンと同じ考え方（採否の根拠は同関数の doc comment）。
 */
async function checkNoCodexMcpToken(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_codex_mcp_token';
  const probed = await probeFile(transport, '${CODEX_HOME:-$HOME/.codex}/config.toml');
  if (!probed.ok) return { id, status: 'unknown', detail: `Codex config.toml の${probed.detail}` };
  const { probe } = probed;
  if (probe.kind === 'absent') {
    return { id, status: 'pass', detail: 'config.toml が存在しません' };
  }
  if (probe.kind === 'unrecognized') {
    return { id, status: 'unknown', detail: 'config.toml の取得結果が想定外の形式でした' };
  }
  if (hasCodexConfigUiToken(probe.content)) {
    return { id, status: 'fail', detail: 'config.toml に AZITO_UI_TOKEN が残っています' };
  }
  return { id, status: 'pass', detail: 'config.toml に AZITO_UI_TOKEN はありません' };
}

export async function runIsolationDoctor(transport: IServerTransport, hub: HubIdentity): Promise<IsolationDoctorResult> {
  const checks = await Promise.all([
    checkSameHost(transport, hub),
    checkNoPrivateKeys(transport),
    checkGhUnauthenticated(transport),
    checkNoGitCredentials(transport),
    checkNoOperatorToken(transport),
    checkNoClaudeMcpToken(transport),
    checkNoCodexMcpToken(transport),
  ]);
  const verified = checks.every((c) => c.status === 'pass');
  return { verified, checks };
}

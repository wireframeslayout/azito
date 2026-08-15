import type { IServerTransport } from './transport/ServerTransport';
import { shellQuote } from '../../shared/shellQuote';
import { isAzitoctlEnvFilename } from '../../shared/azitoctlEnv';
import { extractClaudeMcpUiToken, hasCodexConfigUiToken } from '../../shared/mcpTokenStores';
import type { HubCanary } from './hubCanary';

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
  /**
   * Review round (isolation doctor, Critical finding 1): the hub's own
   * FS-boundary canary (see hubCanary.ts) — a small non-secret marker file
   * written into the hub's data directory at startup. `null` when the write
   * failed (or the hub restarted with a read-only data dir); the FS-boundary
   * check degrades to 'unknown' rather than silently skipping the
   * measurement in that case. Resolved once by routes.ts (via
   * `getHubCanary()`) and passed in, matching this interface's own
   * "resolved at the boundary" contract.
   */
  canary: HubCanary | null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Framed file probing (review round, Critical finding 2) ───
//
// The previous implementation searched raw shell stdout for bare marker
// strings like `AZT_FILE_BEGIN` and treated a hit/miss as the file's
// presence/absence, then sliced "content" out from between two such
// markers found via `indexOf`. Any probed file that happened to CONTAIN one
// of those literal marker strings (a settings.json/config.toml with a
// comment or string value quoting them, however unlikely) would corrupt the
// parse silently — content search offset by an in-band collision, or a
// begin/end pair matched against the wrong occurrence. This reimplementation
// never searches file CONTENT for markers: presence/absence and the content
// itself travel on separate, clearly delimited lines (`AZT_STATUS:<key>:...`),
// the content itself is base64-encoded so it cannot contain a literal
// newline (or anything else) that could be mistaken for a status line.
export type FileProbeOutcome =
  | { kind: 'absent' }
  | { kind: 'content'; content: string }
  | { kind: 'unrecognized' };

/**
 * Probes one or more files in a single round-trip. `entries[].pathExpr` must
 * already be valid, safely-quoted shell syntax as it will be embedded
 * VERBATIM into the command line — callers pass either a literal
 * double-quoted string containing only hub-controlled shell variables (e.g.
 * `"$HOME/.claude/settings.json"`, no injection surface since nothing
 * attacker-influenced reaches it) or `shellQuote(...)` of a fully-resolved
 * path when any component (e.g. a filename discovered via a prior `ls`) is
 * remote/attacker-influenced. `entries[].key` must be a fixed, code-controlled
 * identifier (never remote data) — it is embedded directly into the framing
 * markers this function parses back out.
 */
export async function probeFilesFramed(
  transport: IServerTransport,
  entries: { key: string; pathExpr: string }[],
): Promise<{ ok: true; results: Map<string, FileProbeOutcome> } | { ok: false; detail: string }> {
  if (entries.length === 0) return { ok: true, results: new Map() };
  const cmd = entries
    .map(({ key, pathExpr }) =>
      `if [ -f ${pathExpr} ]; then echo "AZT_STATUS:${key}:present"; base64 < ${pathExpr} 2>/dev/null; echo "AZT_STATUS_END:${key}"; else echo "AZT_STATUS:${key}:absent"; fi`)
    .join('; ');
  let result;
  try {
    result = await transport.exec(cmd);
  } catch (err) {
    return { ok: false, detail: `ファイルの取得に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (result.code !== 0) {
    return { ok: false, detail: `ファイルの取得に失敗しました (code ${result.code}): ${result.stderr || result.stdout || '(no output)'}` };
  }
  const lines = result.stdout.split('\n');
  const results = new Map<string, FileProbeOutcome>();
  for (const { key } of entries) {
    const presentIdx = lines.findIndex((l) => l.trim() === `AZT_STATUS:${key}:present`);
    const absentIdx = lines.findIndex((l) => l.trim() === `AZT_STATUS:${key}:absent`);
    if (presentIdx === -1) {
      results.set(key, absentIdx !== -1 ? { kind: 'absent' } : { kind: 'unrecognized' });
      continue;
    }
    const endIdx = lines.findIndex((l, i) => i > presentIdx && l.trim() === `AZT_STATUS_END:${key}`);
    if (endIdx === -1) {
      results.set(key, { kind: 'unrecognized' });
      continue;
    }
    const b64 = lines.slice(presentIdx + 1, endIdx).join('').trim();
    if (b64 === '') {
      results.set(key, { kind: 'content', content: '' });
      continue;
    }
    try {
      results.set(key, { kind: 'content', content: Buffer.from(b64, 'base64').toString('utf-8') });
    } catch {
      results.set(key, { kind: 'unrecognized' });
    }
  }
  return { ok: true, results };
}

/** Single-file convenience wrapper over probeFilesFramed. */
async function probeFile(transport: IServerTransport, pathExpr: string): Promise<{ ok: true; probe: FileProbeOutcome } | { ok: false; detail: string }> {
  const batch = await probeFilesFramed(transport, [{ key: 'f', pathExpr }]);
  if (!batch.ok) return batch;
  return { ok: true, probe: batch.results.get('f') ?? { kind: 'unrecognized' } };
}

/**
 * 1. Same-host / FS-boundary detection (review round, Critical finding 1):
 * an `agent` server that is, for credential-storage purposes,
 * indistinguishable from the hub itself is not actually isolated no matter
 * what `isolationIntent` claims. Three independent signals feed a single
 * fail-closed decision:
 *
 *  - hostname match
 *  - uid match
 *  - the target can actually READ the hub's own FS-boundary canary file
 *    (hubCanary.ts) — the one signal that is a real, measured test of
 *    filesystem reachability rather than an identity heuristic. hostname
 *    can differ across two containers sharing a Docker host's utsname; two
 *    independent hosts can both default to uid 1000. Neither alone (nor
 *    both together) proves or disproves a SHARED filesystem — only actually
 *    trying to read a marker the hub itself just wrote does that.
 *
 * `fail` if the canary was read back with matching content, OR both
 * hostname and uid match. `pass` only when the canary is confirmed
 * unreadable/absent AND both hostname and uid differ — every other
 * combination (one of hostname/uid matching without a canary result either
 * way, or the canary probe itself being inconclusive/unreachable) is
 * `unknown`, never `pass` — this module's fail-closed contract (a check
 * that cannot prove separation must not report separation).
 */
async function checkFsAndHostBoundary(transport: IServerTransport, hub: HubIdentity): Promise<IsolationCheck> {
  const id = 'same_host';
  let hostResult;
  try {
    hostResult = await transport.exec('hostname; id -u');
  } catch (err) {
    return { id, status: 'unknown', detail: `hostname/uid の取得に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (hostResult.code !== 0) {
    return { id, status: 'unknown', detail: `hostname/uid の取得に失敗しました (code ${hostResult.code}): ${hostResult.stderr || hostResult.stdout || '(no output)'}` };
  }
  const lines = hostResult.stdout.split('\n').map((l) => l.trim());
  const remoteHostname = lines[0] ?? '';
  const remoteUidStr = lines[1] ?? '';
  const remoteUid = /^\d+$/.test(remoteUidStr) ? Number(remoteUidStr) : null;
  if (!remoteHostname || remoteUid === null) {
    return { id, status: 'unknown', detail: `hostname/uid の出力が想定外の形式でした: ${JSON.stringify(hostResult.stdout)}` };
  }
  if (hub.uid === null) {
    return { id, status: 'unknown', detail: 'ハブ側の uid を取得できなかったため、同一ホスト判定ができません（process.getuid が利用不可）' };
  }
  const sameHostname = remoteHostname === hub.hostname;
  const sameUid = remoteUid === hub.uid;
  const identity = `agent: ${remoteHostname}/${remoteUid}、hub: ${hub.hostname}/${hub.uid}`;

  // Actual FS-reachability measurement — null means "could not be measured
  // this round" (no canary to test, transport unreachable, or an
  // unrecognized probe result), which must never be folded into a pass.
  let canaryReadable: boolean | null = null;
  if (hub.canary) {
    const probed = await probeFilesFramed(transport, [{ key: 'canary', pathExpr: shellQuote(hub.canary.path) }]);
    if (probed.ok) {
      const outcome = probed.results.get('canary');
      if (outcome?.kind === 'content' && outcome.content === hub.canary.content) canaryReadable = true;
      else if (outcome?.kind === 'absent') canaryReadable = false;
      // 'unrecognized', or 'content' with unexpected bytes (should never
      // happen for a hub-generated random filename, but is not trusted as
      // proof of absence either): canaryReadable stays null.
    }
  }

  if (canaryReadable === true) {
    return {
      id,
      status: 'fail',
      detail: `agent サーバーからハブのデータディレクトリ内のカナリアファイルが読み取れました（同一ファイルシステムを共有しています）: ${hub.canary!.path}`,
    };
  }
  if (sameHostname && sameUid) {
    return { id, status: 'fail', detail: `${identity}（hostname/uid が両方とも一致）` };
  }
  if (canaryReadable === false && !sameHostname && !sameUid) {
    return { id, status: 'pass', detail: `${identity}（一致せず、カナリアファイルも読み取れませんでした — 実測によるファイルシステム分離を確認）` };
  }
  if (canaryReadable === null) {
    return {
      id,
      status: 'unknown',
      detail: hub.canary
        ? `ファイルシステム分離を実測できませんでした（カナリアファイルの読み取り結果が不明でした）。${identity}`
        : `ハブ側にカナリアファイルが存在しないため、ファイルシステム分離を実測できませんでした（ハブ起動時の書き込みに失敗した可能性があります）。${identity}`,
    };
  }
  return {
    id,
    status: 'unknown',
    detail: `${identity}（hostname/uid の一方のみ一致 — カナリアは読み取れませんでしたが、識別子の不一致が確認できないため判定不能です）`,
  };
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
 * Review round (Critical finding 2): file contents are now fetched via the
 * framed base64 batch (`probeFilesFramed`) instead of raw marker search —
 * see that function's own doc comment for why.
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
  // into the shell command unquoted. `probeFilesFramed`'s `key` is our own
  // numeric index (never remote data); `shellQuote` handles arbitrary
  // filename content in `pathExpr`.
  const probed = await probeFilesFramed(
    transport,
    targets.map((name, i) => ({ key: String(i), pathExpr: shellQuote(`${azitoDir}/${name}`) })),
  );
  if (!probed.ok) {
    return { id, status: 'unknown', detail: `azitoctl*.env / operator.env の内容取得に失敗しました: ${probed.detail}` };
  }

  const offenders: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const outcome = probed.results.get(String(i));
    if (!outcome || outcome.kind === 'unrecognized') {
      return { id, status: 'unknown', detail: `${targets[i]} の内容取得結果が想定外の形式でした` };
    }
    if (outcome.kind === 'absent') continue; // listed by `ls` but gone by the time we read it — nothing to flag
    // operator.env carries AZITO_UI_TOKEN=... on the same line grammar
    // azitoctl*.env would if it were ever misconfigured — the same
    // predicate this doctor is already borrowing (see the doc comment
    // above) applies verbatim to both file kinds.
    if (/^AZITO_UI_TOKEN=/m.test(outcome.content)) {
      offenders.push(targets[i]);
    }
  }
  if (offenders.length > 0) {
    return { id, status: 'fail', detail: `AZITO_UI_TOKEN が残っているファイルがあります: ${offenders.join(', ')}` };
  }
  return { id, status: 'pass', detail: `確認済み: ${targets.join(', ')}` };
}

/**
 * 6. Claude の `~/.claude/settings.json` の MCP env に AZITO_UI_TOKEN が
 * 残っていない — `harness/setup.sh --purge-operator-token` が掃除する対象の
 * ひとつ（checkNoOperatorToken の doc comment、および
 * `shared/mcpTokenStores.ts` の doc comment を参照）。判定ロジック
 * （`extractClaudeMcpUiToken`）は `azito auth doctor`
 * （authDoctorCommand.ts の readMcpUiToken）と共有。
 */
async function checkNoClaudeMcpToken(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_claude_mcp_token';
  const probed = await probeFile(transport, '"$HOME/.claude/settings.json"');
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
 * 7. Codex の `config.toml`（`$CODEX_HOME` または `~/.codex`）の
 * `mcp_servers.azt-mcp` env に AZITO_UI_TOKEN が残っていない — 6 と同じ
 * cleanup 対象漏れを埋めるチェック。判定は `hasCodexConfigUiToken`
 * （`shared/mcpTokenStores.ts`）— `harness/setup.sh`
 * `strip_codex_ui_token()` 自身が最終防衛線として使っている保守的な
 * bare-substring スキャンと同じ考え方（採否の根拠は同関数の doc comment）。
 */
async function checkNoCodexMcpToken(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_codex_mcp_token';
  const probed = await probeFile(transport, '"${CODEX_HOME:-$HOME/.codex}/config.toml"');
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

/**
 * 8. 実行環境そのものに operator 相当のトークンが存在しない（review round,
 * Critical finding 3）: `/api/exec` は agent プロセスが継承した環境で
 * `/bin/sh` を起動するため、`AZITO_UI_TOKEN` 付きで起動された agent は
 * ディスク上に何も残っていなくてもそのトークンをコマンド実行環境から露出
 * する。ファイルベースの検査（5〜7）が全て pass でもこの経路は塞がれない
 * ため独立チェックとして追加。
 *
 * 値そのものは絶対に detail/report に含めない — `${VAR+x}` という POSIX
 * パラメータ展開（「設定されているか」だけを問う、値には触れない）で存在
 * 有無のみを問い合わせ、変数名のリストだけを報告する。
 */
async function checkNoOperatorEnvironment(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_operator_environment';
  const varsToCheck = ['AZITO_UI_TOKEN', 'AZITO_AGENT_TOKEN', 'AZITO_WEBHOOK_TOKEN', 'AZITO_MASTER_KEY'];
  const cmd = varsToCheck
    .map((v) => `if [ -n "\${${v}+x}" ]; then echo "AZT_ENV_PRESENT:${v}"; fi`)
    .join('; ') + '; echo AZT_ENV_DONE';
  let result;
  try {
    result = await transport.exec(cmd);
  } catch (err) {
    return { id, status: 'unknown', detail: `実行環境の変数確認に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (result.code !== 0) {
    return { id, status: 'unknown', detail: `実行環境の変数確認に失敗しました (code ${result.code}): ${result.stderr || result.stdout || '(no output)'}` };
  }
  const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.includes('AZT_ENV_DONE')) {
    return { id, status: 'unknown', detail: `実行環境の変数確認結果が想定外の形式でした: ${JSON.stringify(result.stdout)}` };
  }
  const present = lines
    .filter((l) => l.startsWith('AZT_ENV_PRESENT:'))
    .map((l) => l.slice('AZT_ENV_PRESENT:'.length));
  if (present.length > 0) {
    return {
      id,
      status: 'fail',
      detail: `/api/exec が起動する実行環境（プロセス継承環境）に operator 相当の環境変数が存在します。値は表示しません: ${present.join(', ')}`,
    };
  }
  return { id, status: 'pass', detail: '/api/exec が起動する実行環境に operator 相当の環境変数は見つかりませんでした' };
}

export async function runIsolationDoctor(transport: IServerTransport, hub: HubIdentity): Promise<IsolationDoctorResult> {
  const checks = await Promise.all([
    checkFsAndHostBoundary(transport, hub),
    checkNoPrivateKeys(transport),
    checkGhUnauthenticated(transport),
    checkNoGitCredentials(transport),
    checkNoOperatorToken(transport),
    checkNoClaudeMcpToken(transport),
    checkNoCodexMcpToken(transport),
    checkNoOperatorEnvironment(transport),
  ]);
  const verified = checks.every((c) => c.status === 'pass');
  return { verified, checks };
}

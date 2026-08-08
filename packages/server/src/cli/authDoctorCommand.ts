import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { findAzitoctlEnvFiles } from '../shared/azitoctlEnv';
import { resolveCurrentUiToken } from '../shared/currentUiToken';
import { resolveScopedAuthEnabled } from '../shared/auth/scopedAuthFlag';

// ─── azito auth doctor (Issue #28 Phase B, design §12 step 1) ───
//
// Local-only sanity check for the operator/task credential separation
// introduced by the harness distribution split (setup.sh no longer writes
// AZITO_UI_TOKEN into azitoctl*.env; --ui-token instead goes to a new
// operator.env that nothing auto-sources). This command has no notion of
// "the remote servers" — it only reads files on the machine it runs on, and
// says so in its own output, so it isn't mistaken for a fleet-wide audit.

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
    const e = err as NodeJS.ErrnoException & { status?: number };
    if (e.code === 'ENOENT') {
      return {
        ok: true,
        notice: true,
        label,
        detail: 'codex コマンドが見つかりません（Codex を使わない環境では確認不能・問題ありません）',
      };
    }
    // `codex mcp get` exits non-zero when azt-mcp isn't registered in Codex
    // at all (or on some other CLI-side error) — that's "nothing to check",
    // the same "not configured" treatment `checkMcpTokenMatchesHub` gives
    // an absent Claude entry, not a doctor failure.
    return {
      ok: true,
      label,
      detail: 'Codex に azt-mcp が登録されていません（このマシンで Codex を使わない場合は問題ありません）',
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

// (e) AZITO_SCOPED_AUTH の現在値
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
  console.log('ローカル検査のみです。リモートサーバーはそのサーバー上で `azito auth doctor` を実行してください。\n');

  const checks: CheckResult[] = [
    checkAzitoctlEnvNoUiToken(),
    checkOperatorEnvPermissions(),
    checkMcpTokenMatchesHub(),
    checkCodexMcpTokenMatchesHub(),
    checkScopedAuthFlag(),
  ];

  let hasFailure = false;
  for (const check of checks) {
    const mark = check.notice ? (process.stdout.isTTY ? '\x1b[33m-- \x1b[0m' : '-- ') : colorize(check.ok, check.ok ? 'OK ' : 'NG ');
    console.log(`[${mark}] ${check.label}`);
    for (const line of check.detail.split('\n')) {
      console.log(`      ${line}`);
    }
    if (!check.ok) hasFailure = true;
  }

  console.log('');
  if (hasFailure) {
    console.log(colorize(false, '一部の検査に失敗しました。上記の修正手順に従ってください。'));
    process.exitCode = 1;
  } else {
    console.log(colorize(true, 'すべての検査に合格しました。'));
  }
}

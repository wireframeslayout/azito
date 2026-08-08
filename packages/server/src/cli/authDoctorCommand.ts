import fs from 'fs';
import path from 'path';
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
}

function operatorEnvPath(): string {
  return path.join(process.env.HOME || '', '.azito', 'operator.env');
}

function mcpSettingsPath(): string {
  return path.join(process.env.HOME || '', '.claude', 'settings.json');
}

// (a) azitoctl*.env に AZITO_UI_TOKEN が残っていないか
function checkAzitoctlEnvNoUiToken(): CheckResult {
  const label = 'azitoctl*.env に AZITO_UI_TOKEN が残っていない';
  const files = findAzitoctlEnvFiles();
  if (files.length === 0) {
    return { ok: true, label, detail: '~/.azito/azitoctl*.env が見つかりません（未セットアップ、または対象外）' };
  }

  const offenders = files.filter(file => /^AZITO_UI_TOKEN=/m.test(fs.readFileSync(file, 'utf-8')));
  if (offenders.length === 0) {
    return { ok: true, label, detail: `確認済み: ${files.join(', ')}` };
  }
  return {
    ok: false,
    label,
    detail:
      `AZITO_UI_TOKEN が残っています: ${offenders.join(', ')}\n` +
      '  修正: harness/setup.sh を（同じ --azito-url --webhook-token で）再実行してください。' +
      'このファイルは毎回丸ごと書き直されるため、UI トークン行は自動的に消えます。',
  };
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

function readMcpUiToken(settingsPath: string): string | undefined {
  if (!fs.existsSync(settingsPath)) return undefined;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as McpSettingsFile;
    return settings.mcpServers?.['azt-mcp']?.env?.AZITO_UI_TOKEN;
  } catch {
    return undefined;
  }
}

// (c) MCP settings の AZITO_UI_TOKEN がハブの現在値と一致するか
//     （ローカルで読める範囲 — resolveCurrentUiToken() と同じ解決順）
function checkMcpTokenMatchesHub(): CheckResult {
  const label = 'MCP settings の AZITO_UI_TOKEN がハブの現在値と一致';
  const settingsPath = mcpSettingsPath();
  const mcpToken = readMcpUiToken(settingsPath);

  if (!mcpToken) {
    return {
      ok: true,
      label,
      detail: `${settingsPath} に azt-mcp の AZITO_UI_TOKEN が未設定です（このマシンから MCP を使わない場合は問題ありません）`,
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

// (d) AZITO_SCOPED_AUTH の現在値
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
    checkScopedAuthFlag(),
  ];

  let hasFailure = false;
  for (const check of checks) {
    const mark = colorize(check.ok, check.ok ? 'OK ' : 'NG ');
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

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { resolveDataDir } from '../shared/dataDir';
import { resolveServerEnvPath } from '../shared/envFile';
import { resolveCurrentUiToken } from '../shared/currentUiToken';

interface McpServerEnv {
  env?: Record<string, string>;
}

interface McpSettingsFile {
  mcpServers?: Record<string, McpServerEnv>;
}

function operatorEnvPath(): string {
  return path.join(process.env.HOME || '', '.azito', 'operator.env');
}

// operator.env は `KEY=value` を1行1エントリで持つ（harness/setup.sh が
// printf %q で書き出す形式）。ローテート後は AZITO_UI_TOKEN 行だけを
// 書き換える。新トークンは crypto.randomBytes(32).toString('hex') で
// 常に英数字のみなのでシェルクォートは不要（生値のまま書いてよい）。
function updateOperatorEnvToken(newToken: string): boolean {
  const filePath = operatorEnvPath();
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  let updated = false;
  const newLines = lines.map(line => {
    if (/^AZITO_UI_TOKEN=/.test(line)) {
      updated = true;
      return `AZITO_UI_TOKEN=${newToken}`;
    }
    return line;
  });
  if (updated) {
    // Force 0600 regardless of the file's current mode (third-party review
    // Important finding): `mode` on writeFileSync only applies when the file
    // is newly created, and this file always pre-exists (checked above), so
    // it alone would not correct a file that somehow ended up more
    // permissive (e.g. written by an older setup.sh before the umask 077 +
    // atomic-mv fix, or restored from a backup). chmod before writing too,
    // so the content is never briefly readable under a looser mode between
    // this chmod and the write.
    fs.chmodSync(filePath, 0o600);
    fs.writeFileSync(filePath, newLines.join('\n'), { mode: 0o600 });
  }
  return updated;
}

function mcpSettingsPath(): string {
  return path.join(process.env.HOME || '', '.claude', 'settings.json');
}

// ~/.claude/settings.json の mcpServers['azt-mcp'].env.AZITO_UI_TOKEN を
// 更新する。ファイルが無い/JSON として読めない/azt-mcp が未登録/トークンが
// 未設定のいずれの場合も何もしない（新規登録は harness/setup.sh の役割）。
function updateMcpSettingsToken(newToken: string): boolean {
  const filePath = mcpSettingsPath();
  if (!fs.existsSync(filePath)) return false;

  let settings: McpSettingsFile;
  try {
    settings = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as McpSettingsFile;
  } catch {
    return false;
  }

  const mcpEnv = settings.mcpServers?.['azt-mcp']?.env;
  if (!mcpEnv || typeof mcpEnv.AZITO_UI_TOKEN !== 'string') return false;
  if (mcpEnv.AZITO_UI_TOKEN === newToken) return false;

  mcpEnv.AZITO_UI_TOKEN = newToken;
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

export async function tokenCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'show') {
    const result = resolveCurrentUiToken();
    if (result) {
      console.log(result.token);
      return;
    }
    const paths = resolveDataDir();
    const envFilePath = resolveServerEnvPath();
    console.error('UI token not found.');
    console.error(`Checked: AZITO_UI_TOKEN env, ${envFilePath}, ${paths.uiToken}`);
    console.error(`Set AZITO_UI_TOKEN in ${envFilePath}, or start the server once to auto-generate a token file.`);
    process.exit(1);
  }

  if (subcommand === 'rotate') {
    const paths = resolveDataDir();

    // Issue #28 review Important finding: `resolveCurrentUiToken()` mirrors
    // the SAME env -> .env -> token-file precedence the running hub applies
    // (see that function's own doc comment). When env or the server .env
    // wins, the token FILE this command is about to rewrite is not what the
    // hub actually authenticates with at all — rotating it used to still
    // write a brand-new (unusable) token into operator.env and MCP
    // settings, silently breaking every downstream consumer (harness
    // skills, azt-mcp) that reads those while the hub itself kept accepting
    // the OLD token indefinitely. Resolve BEFORE writing anything and abort
    // with guidance instead, rather than distributing a token nobody can
    // actually use.
    const current = resolveCurrentUiToken();
    if (current && current.source !== paths.uiToken) {
      console.error(`Cannot rotate: the hub's effective AZITO_UI_TOKEN currently comes from ${current.source}, not the token file (${paths.uiToken}).`);
      console.error('Rotating the token file would produce a new value the running hub never reads, while still overwriting operator.env / MCP settings with that unusable token.');
      if (current.source === 'env') {
        console.error('Fix: change the AZITO_UI_TOKEN environment variable directly, restart the server, then re-run `azito token rotate`.');
      } else {
        console.error(`Fix: edit AZITO_UI_TOKEN in ${current.source} directly, restart the server, then re-run \`azito token rotate\`.`);
      }
      process.exit(1);
    }

    const newToken = crypto.randomBytes(32).toString('hex');

    fs.mkdirSync(path.dirname(paths.uiToken), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.uiToken, newToken, { mode: 0o600 });
    console.log(`New UI token written to ${paths.uiToken}`);

    // Issue #28 Phase B: rotate は ~/.azito/azitoctl*.env へ UI トークンを
    // 再配置しない（全権トークンをタスク実行プロセスが source するファイルに
    // 置かない、という配布分離の方針。設計 §9/§12）。ローカルにある operator.env
    // と MCP settings（人間が操作する経路）だけを更新する。
    if (updateOperatorEnvToken(newToken)) {
      console.log(`Updated AZITO_UI_TOKEN in ${operatorEnvPath()}`);
    }
    if (updateMcpSettingsToken(newToken)) {
      console.log(`Updated AZITO_UI_TOKEN in ${mcpSettingsPath()}`);
    }

    if (process.stdout.isTTY) {
      console.log(`\nNew token: ${newToken}`);
    } else {
      console.log('New token written. Read it from the file above.');
    }
    console.log('Restart the server for the new token to take effect.');
    console.log('Remote servers keep their own harness config — re-run harness/setup.sh --ui-token <token> on each of them (see docs/*/security-setup.md).');
    return;
  }

  console.error('Usage: azito token <show|rotate>');
  process.exit(1);
}

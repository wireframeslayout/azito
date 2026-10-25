// Codex CLI: the azt-mcp MCP registration (`codex mcp add`), the skills (~/.codex/skills) and the managed block of
// ~/.codex/AGENTS.md. The same range as the Codex section of setup.sh.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const AGENTS_BEGIN = '<!-- AZITO-HARNESS:BEGIN (managed by harness/setup.sh) -->';
const AGENTS_END = '<!-- AZITO-HARNESS:END -->';
export function codexHomeOf(env, homeDir) {
  return env.CODEX_HOME || path.join(homeDir, '.codex');
}

/** The first match of `name` in PATH (with PATHEXT on Windows), or null. No shell is involved. */
export function findOnPath(name, env, platform) {
  const pathValue = env.PATH ?? env.Path ?? '';
  // On Windows only a name with a PATHEXT extension runs (npm also leaves an extensionless sh script and a .ps1 next to the .cmd).
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of pathValue.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* next */ }
    }
  }
  return null;
}

/**
 * What to start for `codex`. A Unix host runs `codex` from PATH. On Windows an npm install leaves a `codex.cmd` shim that Node
 * refuses to start without a shell, and a shell (cmd.exe) cannot be given an arbitrary path safely (non-ASCII, parentheses,
 * `%`, `&`...). So the shim is read for the script it runs (`"%dp0%\\node_modules\\...\\codex.js"`) and that script is started
 * with node, every argument going through argv. A native `codex.exe` is started as it is. Anything else is an error.
 */
export function resolveCodexCommand(env, platform) {
  if (platform !== 'win32') return { file: 'codex', prefix: [] };
  const found = findOnPath('codex', env, platform);
  if (!found) throw new Error('codex が PATH に見つかりません');
  const ext = path.extname(found).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: found, prefix: [] };
  if (ext !== '.cmd' && ext !== '.bat') throw new Error(`codex (${found}) は実行できる形式ではありません`);
  const match = /"%dp0%\\([^"\r\n]+\.(?:c|m)?js)"/i.exec(fs.readFileSync(found, 'utf8'));
  if (!match) throw new Error(`${found} から codex の実体（node のスクリプト）を読み取れません。npm の shim ではない可能性があります`);
  const dir = path.dirname(found);
  const bundledNode = path.join(dir, 'node.exe');
  return { file: fs.existsSync(bundledNode) ? bundledNode : process.execPath, prefix: [path.join(dir, match[1])] };
}

/** Runs `codex <args>`; returns stdout. Throws on a non-zero exit. */
export function runCodex(args, { env, platform }) {
  const { file, prefix } = resolveCodexCommand(env, platform);
  return execFileSync(file, [...prefix, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function tryCodex(args, ctx) {
  try {
    runCodex(args, ctx);
    return true;
  } catch {
    return false;
  }
}

/**
 * `codex mcp remove` + `codex mcp add` as one replacement: config.toml is saved first and put back byte for byte when the add
 * fails, so a failed run never leaves the registration removed. Returns true on success; failures are reported through `fail`.
 */
function replaceMcp(addArgs, ctx, configFile, fail) {
  let backup = null;
  if (fs.existsSync(configFile)) {
    backup = `${configFile}.bak.${process.pid}`;
    try {
      fs.copyFileSync(configFile, backup);
    } catch {
      fail('azt-mcp (Codex): config.toml のバックアップに失敗しました。登録の置き換えを中止します');
      return false;
    }
  }
  tryCodex(['mcp', 'remove', 'azt-mcp'], ctx);
  if (tryCodex(['mcp', 'add', 'azt-mcp', ...addArgs], ctx)) {
    if (backup) fs.rmSync(backup, { force: true });
    return true;
  }
  if (!backup) {
    fail("azt-mcp (Codex): 登録に失敗しました（元々登録は存在しませんでした。'codex mcp add azt-mcp ...' を手動で再設定してください）");
    return false;
  }
  try {
    fs.copyFileSync(backup, configFile);
    fs.rmSync(backup, { force: true });
    fail('azt-mcp (Codex): 再登録に失敗しました。元の config.toml を復元しました（意図した変更は未適用です。手動確認してください）');
  } catch {
    fail(`azt-mcp (Codex): 再登録にも config.toml の復元にも失敗しました。バックアップ: ${backup} を手動で ${configFile} に上書きしてください`);
  }
  return false;
}

function existingMcpUiToken(ctx) {
  try {
    const token = JSON.parse(runCodex(['mcp', 'get', 'azt-mcp', '--json'], ctx))?.transport?.env?.AZITO_UI_TOKEN;
    return typeof token === 'string' ? token : '';
  } catch {
    return '';
  }
}

/** Registers azt-mcp with Codex. The UI token already registered is kept when none is given (as setup.sh does). */
export function registerCodexMcp({ codexHome, mcpServerPath, azitoUrl, uiToken, ctx, log, fail }) {
  // Before anything is changed: a codex that cannot be started is reported with its reason, not as a failed `mcp add`.
  try {
    resolveCodexCommand(ctx.env, ctx.platform);
  } catch (err) {
    fail(`azt-mcp (Codex): ${err.message}`);
    log('  azt-mcp: 登録に失敗しました');
    return;
  }
  const existingToken = uiToken ? '' : existingMcpUiToken(ctx);
  const effective = uiToken || existingToken;
  const args = ['--env', `AZITO_URL=${azitoUrl}`];
  if (effective) args.push('--env', `AZITO_UI_TOKEN=${effective}`);
  else log('  警告: AZITO_UI_TOKEN が設定されていません。--ui-token を付けて再実行してください');
  log(replaceMcp([...args, '--', 'node', mcpServerPath], ctx, path.join(codexHome, 'config.toml'), fail)
    ? '  azt-mcp: 登録しました'
    : '  azt-mcp: 登録に失敗しました（codex mcp add エラー）');
}

/** The managed block of ~/.codex/AGENTS.md: every prompt module, between the AZITO markers (the rest of the file is kept). */
export function writeAgentsBlock({ agentsPath, modulesDir, log }) {
  const files = fs.readdirSync(modulesDir).filter((f) => f.endsWith('.md')).sort();
  const content = files.map((f) => fs.readFileSync(path.join(modulesDir, f), 'utf8').trimEnd()).join('\n\n');
  const block = `${AGENTS_BEGIN}\n${content}\n${AGENTS_END}`;
  let existing = '';
  try {
    existing = fs.readFileSync(agentsPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const begin = existing.indexOf(AGENTS_BEGIN);
  const end = existing.indexOf(AGENTS_END);
  const result = begin !== -1 && end !== -1
    ? existing.substring(0, begin) + block + existing.substring(end + AGENTS_END.length)
    : existing ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
  fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
  fs.writeFileSync(agentsPath, result);
  log(`  AGENTS.md: 更新しました (${files.length} モジュール)`);
}

/** The key part of a line (before the first `=`; a table header has none, so the whole line) holds a double-quoted segment with a backslash. */
function hasEscapedQuotedKey(line) {
  const eq = line.indexOf('=');
  return /"[^"]*\\[^"]*"/.test(eq === -1 ? line : line.slice(0, eq));
}

/**
 * --purge-operator-token: removes AZITO_UI_TOKEN from config.toml. Only the layout `codex mcp add` writes is edited
 * (the key under [mcp_servers.azt-mcp.env]). Anything else that carries the key (an inline table, a dotted key, a multi-line
 * string, a key written with escapes, another table) is not guessed at: it fails closed and names the lines for a manual edit.
 */
export function stripCodexUiToken({ configFile, fail, log }) {
  if (!fs.existsSync(configFile)) return;
  if (fs.lstatSync(configFile).isSymbolicLink()) {
    fail(`azt-mcp (Codex): ${configFile} はシンボリックリンクです（リンク先: ${fs.readlinkSync(configFile)}）。dotfiles 管理等の可能性があるため自動編集しません。リンク先のファイルを手動で確認し、AZITO_UI_TOKEN を除去してください`);
    return;
  }
  const lines = fs.readFileSync(configFile, 'utf8').split('\n');
  const unquote = (s) => s.replace(/[\s'"]/g, '');
  const kept = [];
  const manual = [];
  let inEnvTable = false;
  let removed = false;
  // A double-quoted key segment with a backslash escape (`"AZITO_UI_TOKEN"`) names a key this routine does not decode, so
  // it would slip past every comparison below. Before anything is edited, any such key or table name fails the purge closed.
  const escaped = lines
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !line.trim().startsWith('#') && hasEscapedQuotedKey(line));
  if (escaped.length > 0) {
    fail(`azt-mcp (Codex): ${configFile} にエスケープを含む引用符付きのキー／テーブル名があります。AZITO_UI_TOKEN を確実に除去できないため自動編集しません。以下の行を手動で確認・除去してください:\n${escaped.map(({ line, n }) => `${n}: ${line}`).join('\n')}`);
    return;
  }
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inEnvTable = unquote(trimmed) === '[mcp_servers.azt-mcp.env]';
      kept.push(line);
      return;
    }
    const eq = line.indexOf('=');
    if (inEnvTable && eq !== -1 && /^(['"]?)AZITO_UI_TOKEN\1\s*$/.test(line.slice(0, eq).trim()) && !line.slice(0, eq).includes('\\')) {
      removed = true;
      return;
    }
    if (!trimmed.startsWith('#') && (line.includes('AZITO_UI_TOKEN') || line.includes('"""') || line.includes("'''"))) {
      manual.push(`${i + 1}: ${line}`);
    }
    kept.push(line);
  });
  if (manual.length > 0) {
    fail(`azt-mcp (Codex): ${configFile} に標準のサブテーブル形式ではない AZITO_UI_TOKEN（または複数行文字列）があるため自動編集しません。以下の行を手動で確認・除去してください:\n${manual.join('\n')}`);
    return;
  }
  if (!removed) return;
  fs.writeFileSync(configFile, kept.join('\n'));
  log('  azt-mcp (Codex): --purge-operator-token により config.toml から AZITO_UI_TOKEN を除去しました');
}

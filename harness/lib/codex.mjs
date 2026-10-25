// Codex CLI: the azt-mcp MCP registration (`codex mcp add`), the skills (~/.codex/skills) and the managed block of
// ~/.codex/AGENTS.md. The same range as the Codex section of setup.sh.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const AGENTS_BEGIN = '<!-- AZITO-HARNESS:BEGIN (managed by harness/setup.sh) -->';
const AGENTS_END = '<!-- AZITO-HARNESS:END -->';
// What may appear in an argument of `codex` on Windows, where it is a .cmd shim run through cmd.exe: nothing cmd would interpret.
const CMD_SAFE_ARG = /^[A-Za-z0-9_.:/\\=@+,~ -]*$/;

export function codexHomeOf(env, homeDir) {
  return env.CODEX_HOME || path.join(homeDir, '.codex');
}

/** The first match of `name` in PATH (with PATHEXT on Windows), or null. No shell is involved. */
export function findOnPath(name, env, platform) {
  const pathValue = env.PATH ?? env.Path ?? '';
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
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

/** Runs `codex <args>`; returns stdout. Throws on a non-zero exit. */
export function runCodex(args, { env, platform }) {
  const options = { env, encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] };
  if (platform !== 'win32') return execFileSync('codex', args, options);
  // codex is an npm .cmd shim: Node refuses to start it without a shell, so it goes through cmd.exe with every argument checked.
  const bad = args.find((a) => !CMD_SAFE_ARG.test(a));
  if (bad !== undefined) throw new Error(`codex に渡せない文字を含む引数があります: ${bad}`);
  const quoted = args.map((a) => (a.includes(' ') ? `"${a}"` : a));
  return execFileSync(env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"codex ${quoted.join(' ')}"`], { ...options, windowsVerbatimArguments: true });
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

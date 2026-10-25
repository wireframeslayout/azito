// ~/.claude/settings.json: the azt-mcp MCP server and the AZITO hooks (Stop / UserPromptSubmit / Notification /
// PermissionRequest / SessionStart). The same entries as setup.sh writes, with the Node hook instead of the bash scripts.
import fs from 'node:fs';
import path from 'node:path';

export const MCP_ENTRY_KEY = 'azt-mcp';

/** The hooks, as [Claude Code event, hook kind, hook event (activity only), label]. */
const HOOKS = [
  ['Stop', 'notify', '', 'Stop hook (通知)'],
  ['UserPromptSubmit', 'activity', 'start', 'UserPromptSubmit hook (稼働検出開始)'],
  ['Stop', 'activity', 'stop', 'Stop hook (稼働検出終了)'],
  ['Notification', 'interaction', '', 'Notification hook (未回答検出)'],
  ['PermissionRequest', 'question', '', 'PermissionRequest hook (質問内容取得)'],
  ['SessionStart', 'session', '', 'SessionStart hook (セッション更新)'],
];

export const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HOOK_COMMAND = /azito-hook\.mjs"?\s+(\w+)(?:\s+(start|stop))?(?:\s+--prefix\s+(\S+))?\s*$/;

/**
 * `node "<script>" <kind> [event] [--prefix <p>]`. Claude Code runs a hook command in Git Bash, or in PowerShell when there is no
 * Git Bash; `node "C:/x/azito-hook.mjs" ...` means the same in both (forward slashes, double quotes, no `$` or backtick that
 * either would expand). A prefix is limited to characters that need no quoting in either.
 */
export function hookCommand(hookScript, kind, event, prefix) {
  const script = hookScript.replace(/\\/g, '/');
  if (/["$`]/.test(script)) {
    throw new Error(`hook のパスに " $ \` を含められません（シェルが展開してしまいます）: ${script}`);
  }
  if (prefix && (!PREFIX_PATTERN.test(prefix) || prefix.includes('..'))) {
    throw new Error(`--prefix に使える文字は英数字と . _ - です: ${prefix}`);
  }
  return ['node', `"${script}"`, kind, ...(event ? [event] : []), ...(prefix ? ['--prefix', prefix] : [])].join(' ');
}

function describeHookCommand(command) {
  const m = typeof command === 'string' ? HOOK_COMMAND.exec(command) : null;
  return m ? { kind: m[1], event: m[2] ?? '', prefix: m[3] ?? '' } : null;
}

function readSettings(settingsPath, purge) {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    // First run: no file. In purge mode any other failure must not read as "nothing to purge".
    if (err.code === 'ENOENT') return {};
    if (purge) {
      throw new Error(`--purge-operator-token は ${settingsPath} の読み込みに失敗しました（${err.message}）。ファイルの内容を確認し、AZITO_UI_TOKEN の除去が必要か手動で確認してください。`);
    }
    return {};
  }
}

function upsertMcp(settings, { mcpServerPath, azitoUrl, uiToken }, messages) {
  if (!settings.mcpServers) settings.mcpServers = {};
  const existing = settings.mcpServers[MCP_ENTRY_KEY];
  let changed = false;
  if (existing) {
    if (!existing.env) existing.env = {};
    if (existing.env.AZITO_URL !== azitoUrl) {
      existing.env.AZITO_URL = azitoUrl;
      changed = true;
    }
    // An empty token leaves what is there (a re-run without it must not erase it).
    if (uiToken && existing.env.AZITO_UI_TOKEN !== uiToken) {
      existing.env.AZITO_UI_TOKEN = uiToken;
      changed = true;
    }
    messages.push(changed ? '  azt-mcp: 設定を更新しました' : '  azt-mcp: OK (設定済み)');
  } else {
    settings.mcpServers[MCP_ENTRY_KEY] = {
      command: 'node',
      args: [mcpServerPath],
      env: { AZITO_URL: azitoUrl, ...(uiToken ? { AZITO_UI_TOKEN: uiToken } : {}) },
    };
    changed = true;
    messages.push('  azt-mcp: 追加しました');
  }
  if (!uiToken && !settings.mcpServers[MCP_ENTRY_KEY].env.AZITO_UI_TOKEN) {
    messages.push('  警告: azt-mcp に AZITO_UI_TOKEN が設定されていません。--ui-token を付けて再実行してください');
  }
  return changed;
}

/** One entry per (kind, event, prefix): a second hub's prefix adds its own entry, a re-run with new values replaces the path. */
function upsertHook(settings, eventName, kind, event, prefix, command, label, messages) {
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks[eventName]) settings.hooks[eventName] = [];
  for (const entry of settings.hooks[eventName]) {
    for (const hook of entry.hooks ?? []) {
      const d = describeHookCommand(hook.command);
      if (!d || d.kind !== kind || d.event !== event || d.prefix !== prefix) continue;
      if (hook.command === command) {
        messages.push(`  ${label}: OK (設定済み)`);
        return false;
      }
      hook.command = command;
      messages.push(`  ${label}: 更新しました`);
      return true;
    }
  }
  settings.hooks[eventName].push({ hooks: [{ type: 'command', command }] });
  messages.push(`  ${label}: 追加しました`);
  return true;
}

/**
 * Merges the MCP server and the hooks into settings.json (idempotent: a second run with the same input changes nothing).
 * `purge` only removes AZITO_UI_TOKEN from the MCP env. A prefix run registers the hooks only (no MCP server).
 * Returns the lines to print.
 */
export function mergeClaudeSettings({ settingsPath, hookScript, mcpServerPath, azitoUrl, uiToken, prefix, purge }) {
  const settings = readSettings(settingsPath, purge);
  const messages = [];
  let changed = false;

  if (purge) {
    const env = settings.mcpServers?.[MCP_ENTRY_KEY]?.env;
    if (env && 'AZITO_UI_TOKEN' in env) {
      delete env.AZITO_UI_TOKEN;
      changed = true;
      messages.push('  azt-mcp: --purge-operator-token により AZITO_UI_TOKEN を除去しました（登録/更新はスキップ）');
    } else {
      messages.push('  azt-mcp: 除去対象の AZITO_UI_TOKEN はありません');
    }
    messages.push('  hooks: スキップ (--purge-operator-token)');
  } else {
    if (prefix) {
      messages.push('  azt-mcp: スキップ (--prefix モード)');
    } else if (fs.existsSync(mcpServerPath)) {
      changed = upsertMcp(settings, { mcpServerPath, azitoUrl, uiToken }, messages) || changed;
    } else {
      messages.push('  azt-mcp: スキップ (MCP サーバーが見つかりません)');
    }
    if (fs.existsSync(hookScript)) {
      for (const [eventName, kind, event, label] of HOOKS) {
        changed = upsertHook(settings, eventName, kind, event, prefix, hookCommand(hookScript, kind, event, prefix), label, messages) || changed;
      }
    } else {
      messages.push('  hooks: スキップ (hook スクリプトが見つかりません)');
    }
  }

  if (changed) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return messages;
}

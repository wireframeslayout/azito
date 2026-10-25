import { execFile } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWindowsSecretFileGuard } from '../../../shared/os/windowsSecretFileGuard';

// setup.mjs is run for real, against a temporary home directory (never the developer's ~/.claude or ~/.azito). It runs on every
// OS the CI has; on Windows it creates real junctions and real ACLs, and the hook commands it writes are run by the shells Claude
// Code uses there.
const HARNESS_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'harness');
const SETUP = path.join(HARNESS_DIR, 'setup.mjs');
const HOOK = path.join(HARNESS_DIR, 'hooks', 'azito-hook.mjs');
const isWindows = process.platform === 'win32';
const MISAO_PANE = 'p_01ARZ3NDEKTSV4RRFFQ69G5FAV';

let home: string;
let emptyBin: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'azito-setup-'));
  emptyBin = path.join(home, 'empty-bin');
  fs.mkdirSync(emptyBin);
  home = path.join(home, 'home');
  fs.mkdirSync(home);
});

afterEach(() => {
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
});

interface RunResult { code: number; stdout: string; stderr: string }

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // (Windows names its variables in any case, so PATH is matched without regard to it.)
    if (v !== undefined && !k.startsWith('AZITO_') && !/^path$/i.test(k) && k !== 'CODEX_HOME' && k !== 'CLAUDE_CONFIG_DIR' && k !== 'TMUX_PANE' && k !== 'MISAO_PANE_ID') env[k] = v;
  }
  return { ...env, HOME: home, USERPROFILE: home, PATH: emptyBin, ...extra };
}

function runSetup(args: string[], extraEnv: Record<string, string> = {}, script = SETUP): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: baseEnv(extraEnv), timeout: 120_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'));
const settingsPath = (): string => path.join(home, '.claude', 'settings.json');
const FULL = ['--azito-url', 'http://hub.example:3001', '--webhook-token', 'wh-token', '--ui-token', 'ui-token', '--server-name', 'The "Mirano"'];

function commandsOf(settings: any, event: string): string[] {
  return (settings.hooks[event] as any[]).flatMap((e) => e.hooks.map((h: any) => h.command as string));
}

describe('setup.mjs', () => {
  it('writes the env files, the MCP server, the six hooks, the skill junctions and the rule copies', async () => {
    const result = await runSetup(FULL);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);

    const { parseEnvFile } = await import(pathToFileURL(HOOK).href);
    expect(parseEnvFile(fs.readFileSync(path.join(home, '.azito', 'azitoctl.env'), 'utf8'))).toEqual({
      AZITO_URL: 'http://hub.example:3001', AZITO_WEBHOOK_TOKEN: 'wh-token', AZITO_SERVER_NAME: 'The "Mirano"',
    });
    expect(fs.readFileSync(path.join(home, '.azito', 'azitoctl.env'), 'utf8')).not.toContain('UI_TOKEN');
    expect(parseEnvFile(fs.readFileSync(path.join(home, '.azito', 'operator.env'), 'utf8'))).toEqual({ AZITO_URL: 'http://hub.example:3001', AZITO_UI_TOKEN: 'ui-token' });

    const settings = readJson(settingsPath());
    expect(settings.mcpServers['azt-mcp']).toEqual({
      command: 'node', args: [path.join(HARNESS_DIR, 'skills', 'azt-mcp', 'mcp-server', 'index.js')],
      env: { AZITO_URL: 'http://hub.example:3001', AZITO_UI_TOKEN: 'ui-token' },
    });
    const script = HOOK.replace(/\\/g, '/');
    expect(commandsOf(settings, 'Stop')).toEqual([`node "${script}" notify`, `node "${script}" activity stop`]);
    expect(commandsOf(settings, 'UserPromptSubmit')).toEqual([`node "${script}" activity start`]);
    expect(commandsOf(settings, 'Notification')).toEqual([`node "${script}" interaction`]);
    expect(commandsOf(settings, 'PermissionRequest')).toEqual([`node "${script}" question`]);
    expect(commandsOf(settings, 'SessionStart')).toEqual([`node "${script}" session`]);

    const skill = path.join(home, '.claude', 'skills', 'azt-plan');
    expect(fs.lstatSync(skill).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(skill)).toBe(fs.realpathSync(path.join(HARNESS_DIR, 'skills', 'azt-plan')));
    expect(fs.readFileSync(path.join(home, '.claude', 'rules', 'ui-design-principles.md')).length).toBeGreaterThan(0);
  });

  it('is idempotent: a second run changes no file and says so', async () => {
    await runSetup(FULL);
    const before = {
      settings: fs.readFileSync(settingsPath(), 'utf8'),
      env: fs.readFileSync(path.join(home, '.azito', 'azitoctl.env'), 'utf8'),
      manifest: fs.readFileSync(path.join(home, '.azito', 'harness-copies.json'), 'utf8'),
    };
    const second = await runSetup(FULL);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('azt-plan: OK (既にリンク済み)');
    expect(second.stdout).toContain('azt-mcp: OK (設定済み)');
    expect(second.stdout).not.toContain('更新しました');
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(before.settings);
    expect(fs.readFileSync(path.join(home, '.azito', 'azitoctl.env'), 'utf8')).toBe(before.env);
    expect(fs.readFileSync(path.join(home, '.azito', 'harness-copies.json'), 'utf8')).toBe(before.manifest);
  });

  it('merges into an existing settings.json without touching what is there, and refreshes a changed URL', async () => {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(settingsPath(), JSON.stringify({
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
      mcpServers: { other: { command: 'x' } },
    }));
    await runSetup(FULL);
    await runSetup(['--azito-url', 'http://other:3001', '--webhook-token', 'wh-token', '--server-name', 'n']);
    const settings = readJson(settingsPath());
    expect(settings.model).toBe('opus');
    expect(settings.mcpServers.other).toEqual({ command: 'x' });
    expect(settings.mcpServers['azt-mcp'].env).toEqual({ AZITO_URL: 'http://other:3001', AZITO_UI_TOKEN: 'ui-token' });
    expect(commandsOf(settings, 'Stop')[0]).toBe('echo mine');
    expect(commandsOf(settings, 'Stop')).toHaveLength(3);
  });

  it('--prefix writes its own env file and its own hook entries, and leaves skills, rules and the MCP server alone', async () => {
    await runSetup(FULL);
    const result = await runSetup(['--prefix', 'prod', '--azito-url', 'http://prod:3001', '--webhook-token', 'prod-token', '--server-name', 'prod-srv']);
    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(home, '.azito', 'azitoctl-prod.env'))).toBe(true);
    const settings = readJson(settingsPath());
    const script = HOOK.replace(/\\/g, '/');
    expect(commandsOf(settings, 'UserPromptSubmit')).toEqual([`node "${script}" activity start`, `node "${script}" activity start --prefix prod`]);
    expect(settings.mcpServers['azt-mcp'].env.AZITO_URL).toBe('http://hub.example:3001');
  });

  it('refuses a prefix that could make a file name leave ~/.azito, before writing anything', async () => {
    for (const prefix of ['../evil', 'a/b', '.hidden', 'x..y']) {
      const result = await runSetup(['--prefix', prefix, '--azito-url', 'http://x', '--webhook-token', 't']);
      expect(result.code, prefix).toBe(1);
      expect(result.stderr).toContain('--prefix');
    }
    expect(fs.existsSync(path.join(home, '.azito'))).toBe(false);
  });

  it('refuses a prefix the hook command could not carry through either shell', async () => {
    const result = await runSetup(['--prefix', 'a b', '--azito-url', 'http://x', '--webhook-token', 't']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--prefix');
  });

  it('--purge-operator-token removes the UI token everywhere and registers nothing', async () => {
    await runSetup(FULL);
    const before = readJson(settingsPath());
    const result = await runSetup(['--purge-operator-token']);
    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(home, '.azito', 'operator.env'))).toBe(false);
    const after = readJson(settingsPath());
    expect(after.mcpServers['azt-mcp'].env).toEqual({ AZITO_URL: 'http://hub.example:3001' });
    expect(after.hooks).toEqual(before.hooks);
    expect(fs.existsSync(path.join(home, '.azito', 'azitoctl.env'))).toBe(true);
  });

  it('--purge-operator-token ignores an inherited AZITO_UI_TOKEN and refuses --ui-token', async () => {
    const inherited = await runSetup(['--purge-operator-token'], { AZITO_UI_TOKEN: 'inherited' });
    expect(inherited.code).toBe(0);
    expect(fs.existsSync(path.join(home, '.azito', 'operator.env'))).toBe(false);
    const both = await runSetup(['--purge-operator-token', '--ui-token', 'x']);
    expect(both.code).toBe(1);
    expect(both.stderr).toContain('同時指定できません');
  });

  it('--purge-operator-token fails (does not report "nothing to purge") when settings.json cannot be read', async () => {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(settingsPath(), '{ not json');
    const result = await runSetup(['--purge-operator-token']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('読み込みに失敗');
  });

  it('the tokens can come from the environment (not the argument list)', async () => {
    const result = await runSetup(['--azito-url', 'http://h:3001', '--server-name', 'srv'], { AZITO_WEBHOOK_TOKEN: 'from-env', AZITO_UI_TOKEN: 'ui-from-env' });
    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(home, '.azito', 'azitoctl.env'), 'utf8')).toContain('"from-env"');
    expect(fs.readFileSync(path.join(home, '.azito', 'operator.env'), 'utf8')).toContain('"ui-from-env"');
    expect(result.stdout).not.toContain('from-env');
  });

  it('removes a UI token an older setup left in an azitoctl env file, and keeps the rest', async () => {
    fs.mkdirSync(path.join(home, '.azito'));
    fs.writeFileSync(path.join(home, '.azito', 'azitoctl-old.env'), 'AZITO_URL=http://x\nAZITO_UI_TOKEN=secret\nAZITO_WEBHOOK_TOKEN=w\n');
    await runSetup(FULL);
    expect(fs.readFileSync(path.join(home, '.azito', 'azitoctl-old.env'), 'utf8')).toBe('AZITO_URL=http://x\nAZITO_WEBHOOK_TOKEN=w\n');
  });

  it('replaces an unedited rule copy but leaves an edited one', async () => {
    await runSetup(FULL);
    const rules = path.join(home, '.claude', 'rules');
    const [first, second] = fs.readdirSync(rules);
    const original = fs.readFileSync(path.join(HARNESS_DIR, 'prompt-modules', first), 'utf8');
    fs.writeFileSync(path.join(rules, first), 'an older copy');
    fs.writeFileSync(path.join(rules, second), 'my own edit');
    const manifestPath = path.join(home, '.azito', 'harness-copies.json');
    const manifest = readJson(manifestPath);
    manifest[path.join(rules, first)] = (await import('crypto')).createHash('sha256').update('an older copy').digest('hex');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = await runSetup(FULL);
    expect(fs.readFileSync(path.join(rules, first), 'utf8')).toBe(original);
    expect(fs.readFileSync(path.join(rules, second), 'utf8')).toBe('my own edit');
    expect(result.stdout).toContain(`${second}: スキップ (編集された既存ファイル`);
  });

  it('leaves a real skills directory alone', async () => {
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'azt-plan'), { recursive: true });
    const result = await runSetup(FULL);
    expect(result.stdout).toContain('azt-plan: スキップ (既存ディレクトリ');
    expect(fs.lstatSync(path.join(home, '.claude', 'skills', 'azt-plan')).isSymbolicLink()).toBe(false);
  });

  it.runIf(!isWindows)('keeps the env files owner-only (mode 600)', async () => {
    await runSetup(FULL);
    for (const name of ['azitoctl.env', 'operator.env']) {
      expect(fs.statSync(path.join(home, '.azito', name)).mode & 0o777).toBe(0o600);
    }
  });

  it.runIf(isWindows)('keeps the env files to the current user (protected DACL, checked by the hub\'s guard)', async () => {
    const result = await runSetup(FULL);
    expect(result.code).toBe(0);
    const guard = createWindowsSecretFileGuard(process.env);
    for (const name of ['azitoctl.env', 'operator.env']) {
      expect(guard.inspect(path.join(home, '.azito', name), 'file'), name).toEqual({ ok: true });
    }
  }, 120_000);
});

describe('setup.mjs and Codex', () => {
  /** A `codex` on PATH that records its arguments (a .cmd shim on Windows, like the npm one). */
  function installFakeCodex(failAdd = false): string {
    const log = path.join(home, 'codex-calls.log');
    // As npm lays it out: the script under node_modules, a .cmd shim that runs it, and (to be skipped) an sh script and a .ps1.
    const js = path.join(emptyBin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(js), { recursive: true });
    fs.writeFileSync(js, `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'mcp' && process.argv[3] === 'add' && ${failAdd}) process.exit(1);
if (process.argv[2] === 'mcp' && process.argv[3] === 'get') process.exit(1);
`);
    if (isWindows) {
      fs.writeFileSync(path.join(emptyBin, 'codex'), '#!/bin/sh\nexit 99\n');
      fs.writeFileSync(path.join(emptyBin, 'codex.ps1'), 'exit 99\r\n');
      fs.writeFileSync(path.join(emptyBin, 'codex.cmd'), [
        '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
        'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*', '',
      ].join('\r\n'));
    } else {
      fs.writeFileSync(path.join(emptyBin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
    }
    return log;
  }

  const calls = (log: string): string[][] => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);

  it('registers azt-mcp, junctions the skills and writes the AGENTS.md block', async () => {
    const log = installFakeCodex();
    const result = await runSetup(FULL, { PATHEXT: '.COM;.EXE;.BAT;.CMD' });
    expect(result.code).toBe(0);
    const add = calls(log).find((c) => c[1] === 'add')!;
    expect(add.slice(0, 2)).toEqual(['mcp', 'add']);
    expect(add).toContain('AZITO_URL=http://hub.example:3001');
    expect(add).toContain('AZITO_UI_TOKEN=ui-token');
    expect(add.slice(-2)).toEqual(['node', path.join(HARNESS_DIR, 'skills', 'azt-mcp', 'mcp-server', 'index.js')]);
    expect(fs.lstatSync(path.join(home, '.codex', 'skills', 'azt-plan')).isSymbolicLink()).toBe(true);
    const agents = fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8');
    expect(agents.startsWith('<!-- AZITO-HARNESS:BEGIN')).toBe(true);
    // a second run replaces the block, it does not append another
    await runSetup(FULL, { PATHEXT: '.COM;.EXE;.BAT;.CMD' });
    expect(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8')).toBe(agents);
  }, 60_000);

  it('registers with a harness under a path with non-ASCII characters, parentheses, & and % (no shell sees the path)', async () => {
    const log = installFakeCodex();
    const copy = path.join(path.dirname(home), 'ハーネス (コピー) & 100%', 'harness');
    fs.cpSync(HARNESS_DIR, copy, { recursive: true, filter: (src) => !src.includes('node_modules') });
    const result = await runSetup(FULL, { PATHEXT: '.COM;.EXE;.BAT;.CMD' }, path.join(copy, 'setup.mjs'));
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const add = calls(log).find((c) => c[1] === 'add')!;
    expect(add.slice(-2)).toEqual(['node', path.join(copy, 'skills', 'azt-mcp', 'mcp-server', 'index.js')]);
    expect(add).toContain('AZITO_URL=http://hub.example:3001');
  }, 60_000);

  it('says why when codex cannot be started, and changes nothing', async () => {
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n');
    if (isWindows) fs.writeFileSync(path.join(emptyBin, 'codex.cmd'), '@echo off\r\nrem not an npm shim\r\n');
    else fs.writeFileSync(path.join(emptyBin, 'codex'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    const result = await runSetup(FULL, { PATHEXT: '.COM;.EXE;.BAT;.CMD' });
    expect(result.code).toBe(1);
    expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).toBe('model = "x"\n');
    expect(result.stderr).toContain(isWindows ? '読み取れません' : 'azt-mcp (Codex)');
  }, 60_000);

  it('a failed `codex mcp add` restores config.toml and makes the run fail', async () => {
    installFakeCodex(true);
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n');
    const result = await runSetup(FULL, { PATHEXT: '.COM;.EXE;.BAT;.CMD' });
    expect(result.code).toBe(1);
    expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).toBe('model = "x"\n');
    expect(result.stderr).toContain('azt-mcp (Codex)');
  }, 60_000);

  it('--purge-operator-token removes the key from the standard env table and fails closed on a layout it does not know', async () => {
    fs.mkdirSync(path.join(home, '.codex'));
    const config = path.join(home, '.codex', 'config.toml');
    fs.writeFileSync(config, '[mcp_servers.azt-mcp]\ncommand = "node"\n\n[mcp_servers.azt-mcp.env]\nAZITO_URL = "http://x"\nAZITO_UI_TOKEN = "secret"\n');
    expect((await runSetup(['--purge-operator-token'])).code).toBe(0);
    expect(fs.readFileSync(config, 'utf8')).toBe('[mcp_servers.azt-mcp]\ncommand = "node"\n\n[mcp_servers.azt-mcp.env]\nAZITO_URL = "http://x"\n');

    fs.writeFileSync(config, '[mcp_servers.azt-mcp]\nenv = { AZITO_UI_TOKEN = "secret" }\n');
    const unknown = await runSetup(['--purge-operator-token']);
    expect(unknown.code).toBe(1);
    expect(fs.readFileSync(config, 'utf8')).toContain('secret');
  });

  it.each([
    ['a key written with an escape', '[mcp_servers.azt-mcp.env]\n"AZITO_UI_TOK\\u0045N" = "secret"\n'],
    ['an escaped table name', '[mcp_servers."azt\\u002dmcp".env]\nAZITO_UI_TOKEN = "secret"\n'],
    ['an escaped part of a dotted key', 'mcp_servers."azt-mc\\u0070".env.AZITO_UI_TOKEN = "secret"\n'],
  ])('--purge-operator-token fails closed, before editing, on %s', async (_name, toml) => {
    fs.mkdirSync(path.join(home, '.codex'));
    const config = path.join(home, '.codex', 'config.toml');
    // a standard-layout key that would be removed if the file were edited at all
    const content = `${toml}\n[mcp_servers.azt-mcp.env]\nAZITO_UI_TOKEN = "standard"\n`;
    fs.writeFileSync(config, content);
    const result = await runSetup(['--purge-operator-token']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('手動で確認');
    expect(fs.readFileSync(config, 'utf8')).toBe(content);
  });
});

describe('the hook written by setup.mjs', () => {
  let hub: http.Server;
  let requests: Array<{ url: string; auth: string | undefined; body: string }>;
  let hubUrl: string;

  beforeEach(async () => {
    requests = [];
    hub = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        requests.push({ url: req.url ?? '', auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
    hubUrl = `http://127.0.0.1:${(hub.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => hub.close(resolve));
  });

  async function waitForRequest(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (requests.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  /** Runs a hook command line the way Claude Code does: as a string, in a shell, with the hook input on stdin. */
  function runInShell(shell: string, shellArgs: string[], command: string, extraEnv: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = baseEnv({ MISAO_PANE_ID: MISAO_PANE, PATH: `${path.dirname(process.execPath)}${path.delimiter}${emptyBin}`, ...extraEnv });
      const child = execFile(shell, [...shellArgs, command], { env }, (err) => (err ? reject(err) : resolve()));
      child.stdin?.end(JSON.stringify({ session_id: '0f8fad5b-d9cb-469f-a165-70867728950e' }));
    });
  }

  async function activityStartCommand(): Promise<string> {
    await runSetup(['--azito-url', hubUrl, '--webhook-token', 'hook-token', '--server-name', 'The Mirano']);
    const settings = readJson(settingsPath());
    return commandsOf(settings, 'UserPromptSubmit')[0];
  }

  it('sends the activity event with the profile from the env file (run through sh / PowerShell / Git Bash)', async () => {
    const command = await activityStartCommand();
    // The two shells Claude Code uses on Windows: Git Bash, and PowerShell where there is none.
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const shells: Array<[string, string[]]> = isWindows
      ? [[path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command']],
          ...(fs.existsSync(gitBash) ? [[gitBash, ['-c']] as [string, string[]]] : [])]
      : [['/bin/sh', ['-c']]];
    for (const [shell, args] of shells) {
      requests = [];
      await runInShell(shell, args, command, {});
      await waitForRequest();
      expect(requests, shell).toHaveLength(1);
      expect(requests[0].url).toBe('/api/webhooks/agent-activity');
      expect(requests[0].auth).toBe('Bearer hook-token');
      expect(JSON.parse(requests[0].body)).toEqual({
        serverName: 'The Mirano', misaoPaneId: MISAO_PANE, event: 'start', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      });
    }
  }, 60_000);

  it('keeps the token out of the request body (it reaches the detached sender over its stdin, never its arguments)', async () => {
    const mod = await import(pathToFileURL(HOOK).href);
    const plan = await mod.planHook({
      args: { kind: 'activity', event: 'start', prefix: '' },
      env: { AZITO_URL: hubUrl, AZITO_WEBHOOK_TOKEN: 'secret-token', AZITO_SERVER_NAME: 's', MISAO_PANE_ID: MISAO_PANE },
      homeDir: home, stdinText: '{}',
    });
    expect(plan.token).toBe('secret-token');
    expect(plan.body).not.toContain('secret-token');
  });
});

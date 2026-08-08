import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;
let uiTokenPath: string;
let dotEnvPath: string;
let fakeHome: string;

// Codex CLI availability varies by machine (dev box vs CI) — mock
// `execFileSync` so `checkCodexMcpTokenMatchesHub` is deterministic
// regardless of whether `codex` is actually installed where these tests
// run. Default: behave as if `codex` isn't installed (ENOENT), matching
// most CI environments; individual tests override via mockImplementationOnce.
const execFileSyncMock = vi.fn<(...args: unknown[]) => string>(() => {
  const err = new Error('spawn codex ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
});
// `checkTaskOwnedWindowsBeforeScopedAuth` drives a real TmuxClient ->
// LocalTransport -> `execFile('tmux', ['list-panes', ...], cb)` call to check
// pane liveness. Mocked here (rather than shelling out to a real tmux) so
// the "pane alive" / "pane gone" outcome is deterministic per test. Defaults
// to "pane gone" (callback with an error) — matching a plain `list-panes`
// failure for a target that doesn't exist — so tests that don't care about
// this check aren't affected by whatever tmux happens to be on the host.
const execFileMock = vi.fn(
  (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null, stdout?: string, stderr?: string) => void) => {
    callback(new Error("can't find pane"));
  },
);
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  execFile: (...args: unknown[]) => (execFileMock as unknown as (...a: unknown[]) => void)(...args),
}));

vi.mock('../shared/dataDir', () => ({
  resolveDataDir: () => ({
    dir: tmpDir,
    db: path.join(tmpDir, 'data.db'),
    masterKey: path.join(tmpDir, 'master.key'),
    vapidKeys: path.join(tmpDir, 'vapid-keys.json'),
    uiToken: uiTokenPath,
    browserProfile: path.join(tmpDir, 'browser-profile'),
    sidekicks: path.join(tmpDir, 'sidekicks'),
    updateState: path.join(tmpDir, 'update-state.json'),
    updateLog: path.join(tmpDir, 'update.log'),
    updateChannel: path.join(tmpDir, 'update-channel.json'),
  }),
}));

vi.mock('../shared/envFile', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/envFile')>();
  return {
    ...original,
    resolveServerEnvPath: () => dotEnvPath,
  };
});

describe('authDoctorCommand', () => {
  let originalEnv: string | undefined;
  let originalHome: string | undefined;
  let originalScopedAuth: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-doctor-test-'));
    uiTokenPath = path.join(tmpDir, 'data', 'ui-token');
    dotEnvPath = path.join(tmpDir, '.env');

    originalEnv = process.env.AZITO_UI_TOKEN;
    delete process.env.AZITO_UI_TOKEN;
    originalScopedAuth = process.env.AZITO_SCOPED_AUTH;
    delete process.env.AZITO_SCOPED_AUTH;

    // Sandboxed HOME: this command reads ~/.azito and ~/.claude on whatever
    // machine it runs on. Without this, running the suite on a real
    // developer machine would read their actual operator.env / settings.json.
    originalHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-doctor-home-'));
    process.env.HOME = fakeHome;

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = undefined;

    execFileSyncMock.mockClear();
    execFileSyncMock.mockImplementation(() => {
      const err = new Error('spawn codex ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    execFileMock.mockClear();
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(new Error("can't find pane"));
    });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AZITO_UI_TOKEN = originalEnv;
    } else {
      delete process.env.AZITO_UI_TOKEN;
    }
    if (originalScopedAuth !== undefined) {
      process.env.AZITO_SCOPED_AUTH = originalScopedAuth;
    } else {
      delete process.env.AZITO_SCOPED_AUTH;
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    process.exitCode = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function allLogLines(): string {
    return logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
  }

  // Observed timing out under full-suite parallel execution (never in
  // isolation) — this test does nothing CPU/IO-heavy itself, but with 158
  // other unit test files' workers competing for CPU, vitest's default 5s
  // test timeout can be too tight purely from scheduling contention.
  // Explicit timeout bump, same pattern as the tmux-integration tests'
  // per-test `{ timeout: 30000 }` (see TmuxClient.splitPane.tmuxIntegration.test.ts).
  // "Nothing set up yet" still has two unverifiable checks by default in
  // this suite: the hub DB doesn't exist yet (drain check) and the codex
  // CLI isn't mocked as installed (Codex MCP check) — both are `notice`
  // (unverifiable), not failures. Phase C round-4 review: exit 0 / "すべて
  // の検査に合格しました" must be reserved for a run where every check
  // actually verified something and found it clean, so this now exits 3
  // ("確認できなかった項目があります") instead of the old blanket "all
  // checks passed" that couldn't be told apart from a genuinely clean run.
  it('reports unverifiable (not a pass) when nothing is set up yet', { timeout: 20000 }, async () => {
    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();
    expect(process.exitCode).toBe(3);
    expect(allLogLines()).toContain('確認できなかった項目があります');
  });

  it('fails when azitoctl*.env still has AZITO_UI_TOKEN', async () => {
    const azitoDir = path.join(fakeHome, '.azito');
    fs.mkdirSync(azitoDir, { recursive: true });
    fs.writeFileSync(path.join(azitoDir, 'azitoctl.env'), 'AZITO_URL=http://x\nAZITO_UI_TOKEN=leftover\n');

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(process.exitCode).toBe(1);
    expect(allLogLines()).toContain('azitoctl.env');
  });

  it('passes this one check when azitoctl*.env has no AZITO_UI_TOKEN (overall exit is 3: hub DB + codex CLI still unverifiable in this test env)', async () => {
    const azitoDir = path.join(fakeHome, '.azito');
    fs.mkdirSync(azitoDir, { recursive: true });
    fs.writeFileSync(path.join(azitoDir, 'azitoctl.env'), 'AZITO_URL=http://x\nAZITO_WEBHOOK_TOKEN=y\n');

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(allLogLines()).toContain('[OK ] azitoctl*.env');
    // Overall exit reflects the OTHER checks' unverifiable state (no hub DB,
    // codex CLI not mocked as installed), not this check — see the "reports
    // unverifiable" test above for that combination in isolation.
    expect(process.exitCode).toBe(3);
  });

  // Third-party review Minor finding: a broken symlink (or any unreadable
  // file) among ~/.azito/azitoctl*.env used to throw straight out of
  // `fs.readFileSync` inside this check's `.filter()` — uncaught, that
  // crashed the entire `azito auth doctor` command (a human running it would
  // see neither this nor any of the other three checks' results at all, not
  // even a clean NG). It must instead surface as its own failing check.
  it('fails independently (without crashing the whole command) when an azitoctl*.env entry is unreadable', async () => {
    const azitoDir = path.join(fakeHome, '.azito');
    fs.mkdirSync(azitoDir, { recursive: true });
    fs.symlinkSync(path.join(azitoDir, 'does-not-exist-target'), path.join(azitoDir, 'azitoctl.env'));

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(process.exitCode).toBe(1);
    expect(allLogLines()).toContain('読み取りに失敗しました');
    // The other three checks must still have run and reported (proof the
    // command didn't abort partway through).
    expect(allLogLines()).toContain('AZITO_SCOPED_AUTH の現在値');
  });

  it('fails when operator.env permissions are not 0600', async () => {
    const azitoDir = path.join(fakeHome, '.azito');
    fs.mkdirSync(azitoDir, { recursive: true });
    const operatorEnvPath = path.join(azitoDir, 'operator.env');
    fs.writeFileSync(operatorEnvPath, 'AZITO_UI_TOKEN=x\n', { mode: 0o644 });

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(process.exitCode).toBe(1);
    expect(allLogLines()).toContain('operator.env');
  });

  it('passes this one check when operator.env is 0600 (overall exit is 3: hub DB + codex CLI still unverifiable in this test env)', async () => {
    const azitoDir = path.join(fakeHome, '.azito');
    fs.mkdirSync(azitoDir, { recursive: true });
    const operatorEnvPath = path.join(azitoDir, 'operator.env');
    fs.writeFileSync(operatorEnvPath, 'AZITO_UI_TOKEN=x\n', { mode: 0o600 });

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(allLogLines()).toContain('[OK ] operator.env');
    expect(process.exitCode).toBe(3);
  });

  it('fails when MCP settings token does not match the hub token', async () => {
    process.env.AZITO_UI_TOKEN = 'hub-token';
    const claudeDir = path.join(fakeHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ mcpServers: { 'azt-mcp': { env: { AZITO_UI_TOKEN: 'stale-token' } } } }),
    );

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(process.exitCode).toBe(1);
    expect(allLogLines()).toContain('MCP settings');
  });

  it('passes this one check when MCP settings token matches the hub token (overall exit is 3: hub DB + codex CLI still unverifiable in this test env)', async () => {
    process.env.AZITO_UI_TOKEN = 'hub-token';
    const claudeDir = path.join(fakeHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ mcpServers: { 'azt-mcp': { env: { AZITO_UI_TOKEN: 'hub-token' } } } }),
    );

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(allLogLines()).toContain('[OK ] MCP settings');
    expect(process.exitCode).toBe(3);
  });

  // Issue #28 review Minor finding: an unreadable/broken settings.json used
  // to be indistinguishable from "azt-mcp has no token configured", which
  // this doctor check reported as a pass — a human editing the file by hand
  // (or a tool that crashed mid-write) would never learn the file was
  // actually broken.
  it('fails independently when MCP settings.json is not valid JSON', async () => {
    const claudeDir = path.join(fakeHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{ this is not valid json');

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(process.exitCode).toBe(1);
    expect(allLogLines()).toContain('読み取りまたは JSON パースに失敗');
  });

  it('reports AZITO_SCOPED_AUTH current value', async () => {
    process.env.AZITO_SCOPED_AUTH = '1';
    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();
    expect(allLogLines()).toContain('scoped 認可: 有効');
  });

  // Phase C round-4 review: "all checks passed" / exit 0 must be reserved
  // for a run where every check actually verified something and found it
  // clean — none `notice` (unverifiable), none `warning`. This is the one
  // scenario in the suite that clears all six checks: AZITO_SCOPED_AUTH
  // enabled (skips the drain check cleanly, no live-pane concern), no stray
  // AZITO_UI_TOKEN in azitoctl.env, operator.env at 0600, and both the
  // Claude and Codex azt-mcp registrations matching the hub's current token.
  it('reports a clean pass with exit 0 when every check actually verifies something and finds it clean', async () => {
    process.env.AZITO_UI_TOKEN = 'hub-token';
    process.env.AZITO_SCOPED_AUTH = '1';

    const azitoDir = path.join(fakeHome, '.azito');
    fs.mkdirSync(azitoDir, { recursive: true });
    fs.writeFileSync(path.join(azitoDir, 'azitoctl.env'), 'AZITO_URL=http://x\nAZITO_WEBHOOK_TOKEN=y\n');
    fs.writeFileSync(path.join(azitoDir, 'operator.env'), 'AZITO_UI_TOKEN=hub-token\n', { mode: 0o600 });

    const claudeDir = path.join(fakeHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ mcpServers: { 'azt-mcp': { env: { AZITO_UI_TOKEN: 'hub-token' } } } }),
    );

    execFileSyncMock.mockImplementation(
      () => JSON.stringify({ transport: { env: { AZITO_UI_TOKEN: 'hub-token' } } }),
    );

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(process.exitCode).toBeUndefined();
    expect(allLogLines()).toContain('すべての検査に合格しました');
    expect(allLogLines()).not.toContain('[!! ]');
    expect(allLogLines()).not.toContain('[-- ]');
  });

  // Fix 1 (Phase C review, Important): while AZITO_SCOPED_AUTH is off,
  // `azito auth doctor` must be able to point out live task-owned tmux panes
  // on the local server — those keep AZITO_UI_TOKEN in their pane env for
  // life, so a still-live pane created before enabling the flag can keep
  // acting as an operator-equivalent principal after the flag flips.
  describe('task-owned window drain check', () => {
    async function seedTaskWindow(tmuxTarget: string): Promise<void> {
      const { openDatabase } = await import('../shared/db/Database.js');
      const db = openDatabase(path.join(tmpDir, 'data.db'));
      try {
        db.prepare("INSERT INTO projects (name) VALUES ('p')").run();
        db.prepare("INSERT INTO tasks (project_id, title) VALUES (1, 't')").run();
        db.prepare(
          "INSERT INTO windows (owner_type, task_id, server_name, tmux_target) VALUES ('task', 1, 'local', ?)",
        ).run(tmuxTarget);
      } finally {
        db.close();
      }
    }

    it('reports a notice (not a failure) when the DB has not been created on this machine yet — this host is not the hub', async () => {
      const { authDoctorCommand } = await import('./authDoctorCommand.js');
      await authDoctorCommand();

      // Phase C round-4 review: unverifiable (`notice`) is no longer folded
      // into exit 0 — it now gets its own non-zero code (3), distinct from
      // both a clean pass (undefined/0) and an actual failure (1).
      expect(process.exitCode).toBe(3);
      expect(allLogLines()).toContain('このホストはハブではありません');
      expect(allLogLines()).toContain('ハブが動いているサーバー上で');
    });

    it('passes this check with no warning when no task-owned windows exist on the local server (overall exit is 3: codex CLI still unverifiable in this test env)', async () => {
      const { openDatabase } = await import('../shared/db/Database.js');
      openDatabase(path.join(tmpDir, 'data.db')).close(); // just runs migrations, seeds 'local' server

      const { authDoctorCommand } = await import('./authDoctorCommand.js');
      await authDoctorCommand();

      expect(process.exitCode).toBe(3);
      expect(allLogLines()).toContain('タスク所有ウィンドウの登録がありません');
    });

    it('passes this check with no warning when the registered task window has no live tmux pane (overall exit is 3: codex CLI still unverifiable in this test env)', async () => {
      await seedTaskWindow('sess:1.0');
      // default execFileMock behavior is "pane gone"

      const { authDoctorCommand } = await import('./authDoctorCommand.js');
      await authDoctorCommand();

      expect(process.exitCode).toBe(3);
      expect(allLogLines()).toContain('生存中の tmux ペインはありません');
    });

    it('warns (without failing) when a task-owned window has a live tmux pane and AZITO_SCOPED_AUTH is off', async () => {
      await seedTaskWindow('sess:1.0');
      execFileMock.mockImplementation((_cmd, _args, _opts, callback) => callback(null, '', ''));

      const { authDoctorCommand } = await import('./authDoctorCommand.js');
      await authDoctorCommand();

      // warning (exit 2) takes precedence over the codex-CLI notice also
      // present in this test env — see authDoctorCommand()'s severity order.
      expect(process.exitCode).toBe(2);
      expect(allLogLines()).toContain('[!! ] scoped 認可 有効化前の生存タスクウィンドウ');
      expect(allLogLines()).toContain('生存中のタスク所有ウィンドウが 1 件見つかりました');
      expect(allLogLines()).toContain('scoped 有効化前に、これらのタスクを終端させるか再生成してください');
      expect(allLogLines()).toContain('azito token rotate');
    });

    // Issue #28 third-party review finding (Important): the drain check
    // previously only ever looked at `type = 'local'` rows, so a live pane
    // on an `agent` server went entirely unchecked while still being folded
    // into a clean/green result. It must now cover every server the hub's
    // DB knows about — and a server it cannot currently reach (down, wrong
    // token, network partition) must be reported as unverifiable, never
    // silently treated as "no live pane found" (clean).
    it('reports a server it cannot reach as unverifiable, never as a clean pass', async () => {
      const { openDatabase } = await import('../shared/db/Database.js');
      const db = openDatabase(path.join(tmpDir, 'data.db'));
      db.prepare(
        "INSERT INTO servers (name, type, host, agent_port, agent_token) VALUES ('remote1', 'agent', '127.0.0.1', 1, 'tok')",
      ).run();
      db.prepare("INSERT INTO projects (name) VALUES ('p')").run();
      db.prepare("INSERT INTO tasks (project_id, title) VALUES (1, 't')").run();
      db.prepare(
        "INSERT INTO windows (owner_type, task_id, server_name, tmux_target) VALUES ('task', 1, 'remote1', 'sess:1.0')",
      ).run();
      db.close();

      const { authDoctorCommand } = await import('./authDoctorCommand.js');
      await authDoctorCommand();

      expect(process.exitCode).toBe(3);
      expect(allLogLines()).toContain('[-- ] scoped 認可 有効化前の生存タスクウィンドウ');
      expect(allLogLines()).toContain('検査できないサーバー上にタスク所有ウィンドウが');
      expect(allLogLines()).toContain('到達不能');
      expect(allLogLines()).not.toContain('生存中の tmux ペインはありません');
    });

    it('surfaces both a confirmed-live local pane and an unreachable remote server in the same warning', async () => {
      await seedTaskWindow('sess:1.0');
      execFileMock.mockImplementation((_cmd, _args, _opts, callback) => callback(null, '', ''));

      const { openDatabase } = await import('../shared/db/Database.js');
      const db = openDatabase(path.join(tmpDir, 'data.db'));
      db.prepare(
        "INSERT INTO servers (name, type, host, agent_port, agent_token) VALUES ('remote1', 'agent', '127.0.0.1', 1, 'tok')",
      ).run();
      db.prepare(
        "INSERT INTO windows (owner_type, task_id, server_name, tmux_target) VALUES ('task', 1, 'remote1', 'sess:2.0')",
      ).run();
      db.close();

      const { authDoctorCommand } = await import('./authDoctorCommand.js');
      await authDoctorCommand();

      // warning (exit 2) takes precedence over the codex-CLI notice also
      // present in this test env.
      expect(process.exitCode).toBe(2);
      expect(allLogLines()).toContain('[!! ] scoped 認可 有効化前の生存タスクウィンドウ');
      expect(allLogLines()).toContain('生存中のタスク所有ウィンドウが 1 件見つかりました');
      expect(allLogLines()).toContain('検査できなかったタスク所有ウィンドウも');
    });

    // Fix 1 (Issue #28 third-party review, Important): existing tests above
    // only ever seed plaintext agent_token values, so they never exercised
    // `open()`'s throw path. In production, `servers.agent_token` is stored
    // SecretBox-encrypted (`v1.<iv>.<tag>.<ciphertext>`), and the dispatch in
    // main.ts used to call `authDoctorCommand()` before `initSecretBox()`
    // ran — so any encrypted token crashed `open()` with "SecretBox not
    // initialized", which propagated all the way out of
    // `checkTaskOwnedWindowsBeforeScopedAuth` and killed the ENTIRE `azito
    // auth doctor` run (a human would see none of the six checks' results,
    // not even a clean NG). This test intentionally does NOT call
    // `initSecretBox` (this file never does), reproducing that exact
    // uninitialized state; the command must now report that one server as
    // unverifiable and keep running every other check instead of throwing.
    it('does not crash when a server row has an encrypted agent_token and SecretBox has not been initialized', async () => {
      const { openDatabase } = await import('../shared/db/Database.js');
      const db = openDatabase(path.join(tmpDir, 'data.db'));
      db.prepare(
        "INSERT INTO servers (name, type, host, agent_port, agent_token) VALUES " +
          "('remote1', 'agent', '127.0.0.1', 1, 'v1.aWl2aWl2aWl2aWl2aWl2aWl2.dGFndGFndGFndGFndGFndGFn.Y2lwaGVydGV4dA==')",
      ).run();
      db.prepare("INSERT INTO projects (name) VALUES ('p')").run();
      db.prepare("INSERT INTO tasks (project_id, title) VALUES (1, 't')").run();
      db.prepare(
        "INSERT INTO windows (owner_type, task_id, server_name, tmux_target) VALUES ('task', 1, 'remote1', 'sess:1.0')",
      ).run();
      db.close();

      const { authDoctorCommand } = await import('./authDoctorCommand.js');
      await authDoctorCommand();

      // The whole command must have completed (not thrown) and every other
      // check must still have run — proof the decrypt failure was contained
      // to this one server, not fatal to the whole run.
      expect(allLogLines()).toContain('[-- ] scoped 認可 有効化前の生存タスクウィンドウ');
      expect(allLogLines()).toContain('検査できないサーバー上にタスク所有ウィンドウが');
      expect(allLogLines()).toContain('サーバー設定の復号に失敗');
      expect(allLogLines()).toContain('AZITO_SCOPED_AUTH の現在値');
    });

    it('is skipped once AZITO_SCOPED_AUTH is already enabled, even with a live task-owned pane', async () => {
      await seedTaskWindow('sess:1.0');
      execFileMock.mockImplementation((_cmd, _args, _opts, callback) => callback(null, '', ''));
      process.env.AZITO_SCOPED_AUTH = '1';

      const { authDoctorCommand } = await import('./authDoctorCommand.js');
      await authDoctorCommand();

      // Drain check itself is a clean skip (no notice/warning); the codex-CLI
      // notice still present in this test env is what drives the overall
      // exit code to 3.
      expect(process.exitCode).toBe(3);
      expect(allLogLines()).not.toContain('[!! ]');
      expect(allLogLines()).toContain('この検査は未有効時のみ対象');
    });
  });

  describe('Codex MCP token check', () => {
    it('reports a notice (not a failure) when the codex CLI is not installed', async () => {
      // default mock already throws ENOENT
      const { authDoctorCommand } = await import('./authDoctorCommand.js');
      await authDoctorCommand();

      // Two independent notices here (codex CLI + no hub DB in this test
      // env) both map to the same exit 3 ("unverifiable"), never exit 0.
      expect(process.exitCode).toBe(3);
      expect(allLogLines()).toContain('codex コマンドが見つかりません');
      expect(allLogLines()).toContain('[-- ] Codex MCP settings');
    });

    it('passes this check (not-configured) when codex is installed but azt-mcp is not registered (overall exit is 3: hub DB still unverifiable in this test env)', async () => {
      execFileSyncMock.mockImplementation(() => {
        const err = new Error('Command failed') as NodeJS.ErrnoException & { status?: number; stderr?: string; stdout?: string };
        err.status = 1;
        err.stderr = "Error: No MCP server named 'azt-mcp' found.\n";
        err.stdout = '';
        throw err;
      });
      const { authDoctorCommand } = await import('./authDoctorCommand.js');
      await authDoctorCommand();

      expect(process.exitCode).toBe(3);
      expect(allLogLines()).toContain('Codex に azt-mcp が登録されていません');
    });

    // Nit finding (Issue #28 Phase C review): a non-ENOENT failure that is
    // NOT the "not registered" shape (timeout, permission error, corrupted
    // config) used to be rounded down to the same green "not registered"
    // result as a genuine absence — a human would never learn the check
    // couldn't actually verify anything. It must surface as a notice with
    // the original error, not a pass.
    it('reports a notice (not a pass) when codex mcp get fails for a reason other than "not registered"', async () => {
      execFileSyncMock.mockImplementation(() => {
        const err = new Error('Command failed') as NodeJS.ErrnoException & { status?: number; stderr?: string; stdout?: string };
        err.status = 1;
        err.stderr = 'Error: config.toml is corrupted\n';
        err.stdout = '';
        throw err;
      });
      const { authDoctorCommand } = await import('./authDoctorCommand.js');
      await authDoctorCommand();

      expect(process.exitCode).toBe(3);
      expect(allLogLines()).toContain('登録状況を確認できませんでした');
      expect(allLogLines()).toContain('config.toml is corrupted');
      expect(allLogLines()).toContain('[-- ] Codex MCP settings');
    });

    it('fails when the Codex azt-mcp token does not match the hub token', async () => {
      process.env.AZITO_UI_TOKEN = 'hub-token';
      execFileSyncMock.mockImplementation(
        () => JSON.stringify({ transport: { env: { AZITO_UI_TOKEN: 'stale-codex-token' } } }),
      );
      const { authDoctorCommand } = await import('./authDoctorCommand.js');
      await authDoctorCommand();

      expect(process.exitCode).toBe(1);
      expect(allLogLines()).toContain('Codex 側の azt-mcp トークンとハブの現在値');
    });

    it('passes this check when the Codex azt-mcp token matches the hub token (overall exit is 3: hub DB still unverifiable in this test env)', async () => {
      process.env.AZITO_UI_TOKEN = 'hub-token';
      execFileSyncMock.mockImplementation(
        () => JSON.stringify({ transport: { env: { AZITO_UI_TOKEN: 'hub-token' } } }),
      );
      const { authDoctorCommand } = await import('./authDoctorCommand.js');
      await authDoctorCommand();

      expect(process.exitCode).toBe(3);
    });

    it('fails independently when the codex JSON output cannot be parsed', async () => {
      execFileSyncMock.mockImplementation(() => 'not json');
      const { authDoctorCommand } = await import('./authDoctorCommand.js');
      await authDoctorCommand();

      expect(process.exitCode).toBe(1);
      expect(allLogLines()).toContain('JSON パースに失敗しました');
    });
  });
});

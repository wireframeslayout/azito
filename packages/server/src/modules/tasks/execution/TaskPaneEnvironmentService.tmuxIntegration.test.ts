import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { TaskPaneEnvironmentService } from './TaskPaneEnvironmentService';
import { TmuxClient } from '../../tmux/TmuxClient';
import { TransportFactory } from '../../servers/transport/TransportFactory';
import type { ITaskTokenRepository } from '../tokens/TaskToken';
import type { Task } from '../Task';
import type { ServerConfig } from '../../servers/Server';

// Issue #28 third-party review finding (Critical): a task pane must never
// see AZITO_UI_TOKEN/AZITO_AGENT_TOKEN inherited from the tmux SESSION's
// environment, no matter how that session's env got polluted (an old
// project-session bootstrap, a manual "New Session" a human made, or any
// future call site nobody remembered to audit). The unit test in
// TaskPaneEnvironmentService.test.ts only checks the JS object
// buildEnvForNewWindow() returns; this test drives real tmux to confirm the
// `-e KEY=''` override this class emits actually masks a session-level value
// in the pane a task worker runs in — the property the fix depends on.
const LOCAL_SERVER: ServerConfig = { name: 'local', type: 'local', muxRuntime: 'system' } as ServerConfig;
const SESSION = `azito-test-env-leak-${process.pid}-${Date.now()}`;

function tmux(...args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls capture-pane until `predicate` matches or `timeoutMs` elapses (shell
 * startup time under a loaded test run is not fixed). Test-stabilization fix
 * (third-party review): this used to default to 5000ms, which this file's
 * lone `it()` also relied on as its own implicit vitest test timeout — under
 * full-suite parallel execution (many other test files' workers competing
 * for CPU), a real `tmux new-window`/shell-startup round trip can take
 * noticeably longer than that, so the poll would still be waiting when
 * vitest's own test timeout fired first. Raised well above what's been
 * observed necessary even under load; the `it()` below sets a matching
 * explicit timeout (see TmuxClient.splitPane.tmuxIntegration.test.ts, which
 * already did this).
 */
async function waitForPane(target: string, predicate: (text: string) => boolean, timeoutMs = 20000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = tmux('capture-pane', '-p', '-t', target);
    if (predicate(last)) return last;
    await sleep(100);
  }
  return last;
}

afterEach(() => {
  try { tmux('kill-session', '-t', SESSION); } catch { /* already gone */ }
});

describe('TaskPaneEnvironmentService x real tmux: session-env leak', () => {
  it('a task window created inside a session that already carries AZITO_UI_TOKEN does not see it', { timeout: 30000 }, async () => {
    // Simulate a session whose environment was polluted with the UI token —
    // e.g. by a project session bootstrap or manual terminal creation that
    // used `tmux.uiTokenEnv()` on `createSession` (which sets SESSION-level
    // env, not just that one window's — see projects/routes.ts's own fix
    // comment). This is the exact scenario the review flagged: any window
    // created afterwards in this session, by any code path, would otherwise
    // inherit this value with no `-e` of its own.
    tmux('new-session', '-d', '-s', SESSION, '-n', 'w1', '-e', 'AZITO_UI_TOKEN=leaked-full-power-token');

    const taskTokenRepo: Pick<ITaskTokenRepository, 'issueNextGeneration' | 'revokeAllForTask'> = {
      issueNextGeneration: vi.fn(() => ({ id: 1, token: 'azt.task.1.' + 'a'.repeat(64) })),
      revokeAllForTask: vi.fn(() => 1),
    };
    const projectSecretRepo = { findByProjectWithValues: vi.fn(() => []) };
    // scopedAuthEnabled = true: the masking branch under test.
    const paneEnvService = new TaskPaneEnvironmentService(taskTokenRepo as ITaskTokenRepository, projectSecretRepo as any, 'ui-token-should-never-appear', true);
    const task = { id: 42, projectId: 1 } as Task;
    const { env } = paneEnvService.buildEnvForNewWindow(task, LOCAL_SERVER);
    expect(env.AZITO_UI_TOKEN).toBe('');

    const transportFactory = new TransportFactory('http://127.0.0.1:1');
    const tmuxClient = new TmuxClient(transportFactory, 'http://127.0.0.1:1', 'ui-token-should-never-appear', 'http://127.0.0.1:1');
    const { windowName } = await tmuxClient.createWindow(LOCAL_SERVER, SESSION, 'task-window', { exactName: true, extraEnv: env });
    const target = `${SESSION}:${windowName}`;

    // Wait for the pane's shell to actually be ready to accept input, rather
    // than a fixed sleep — shell startup time varies under a loaded test run.
    await waitForPane(target, (text) => text.trim().length > 0);
    tmux('send-keys', '-t', target, 'echo "AZITO_UI_TOKEN_IS=[$AZITO_UI_TOKEN]"', 'Enter');
    // Match the marker only at the start of a line — right after `send-keys`
    // the still-unprocessed command line itself is visible in the pane
    // (literally containing this same substring) before the shell has run
    // it, which would otherwise satisfy a plain `includes()` check instantly
    // and read the captured pane before Enter actually executed anything.
    const captured = await waitForPane(target, (text) => /^AZITO_UI_TOKEN_IS=/m.test(text));

    expect(captured).toContain('AZITO_UI_TOKEN_IS=[]');
    expect(captured).not.toContain('leaked-full-power-token');
  });
});

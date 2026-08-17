import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { TmuxClient } from './TmuxClient';
import { TransportFactory } from '../servers/transport/TransportFactory';
import type { ServerConfig } from '../servers/Server';

// Issue #28 review (Critical finding): WindowRespawnService.restorePaneLayout()
// restores a multi-pane task window by calling TmuxClient.splitPane() for
// every pane after the first. `new-window -e`/`new-session -e` only affect
// the window's FIRST pane; a plain `split-window` (no `-e` of its own)
// inherits the tmux SESSION's environment instead — verified directly
// against real tmux here, the same way
// TaskPaneEnvironmentService.tmuxIntegration.test.ts verifies the
// window-creation side of this inheritance behavior. Before the fix,
// splitPane() had no `extraEnv` parameter at all, so a restored task pane
// beyond the first silently inherited whatever the session carried (e.g. an
// operator's own AZITO_UI_TOKEN) instead of the task's scoped
// AZITO_TASK_TOKEN.
const LOCAL_SERVER: ServerConfig = { name: 'local', type: 'local', muxRuntime: 'system' } as ServerConfig;
const SESSION = `azito-test-split-env-${process.pid}-${Date.now()}`;

function tmux(...args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test-stabilization fix (third-party review): raised from 15000ms — under
// full-suite parallel execution a real tmux round trip can take longer than
// that when many other test files' workers are competing for CPU. See the
// matching fix/comment in TaskPaneEnvironmentService.tmuxIntegration.test.ts.
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

describe('TmuxClient.splitPane x real tmux: session-env inheritance', () => {
  it('without extraEnv, a split pane inherits the session-level value (documents the gap)', { timeout: 30000 }, async () => {
    tmux('new-session', '-d', '-s', SESSION, '-n', 'w1', '-e', 'AZITO_UI_TOKEN=leaked-full-power-token');
    const target = `${SESSION}:w1`;
    await waitForPane(target, (text) => text.trim().length > 0);

    const transportFactory = new TransportFactory('http://127.0.0.1:1');
    const tmuxClient = new TmuxClient(transportFactory, 'http://127.0.0.1:1', 'ui-token-should-never-appear', 'http://127.0.0.1:1');
    await tmuxClient.splitPane(LOCAL_SERVER, target, 'v');

    const paneIds = tmux('list-panes', '-t', target, '-F', '#{pane_id}').trim().split('\n');
    expect(paneIds.length).toBe(2);
    const newPaneId = paneIds[1];
    await waitForPane(newPaneId, (text) => text.trim().length > 0);
    tmux('send-keys', '-t', newPaneId, 'echo "AZITO_UI_TOKEN_IS=[$AZITO_UI_TOKEN]"', 'Enter');
    const captured = await waitForPane(newPaneId, (text) => /^AZITO_UI_TOKEN_IS=/m.test(text));

    expect(captured).toContain('AZITO_UI_TOKEN_IS=[leaked-full-power-token]');
  });

  it('extraEnv overrides the inherited session-level value in the new pane', { timeout: 30000 }, async () => {
    tmux('new-session', '-d', '-s', SESSION, '-n', 'w1', '-e', 'AZITO_UI_TOKEN=leaked-full-power-token');
    const target = `${SESSION}:w1`;
    await waitForPane(target, (text) => text.trim().length > 0);

    const transportFactory = new TransportFactory('http://127.0.0.1:1');
    const tmuxClient = new TmuxClient(transportFactory, 'http://127.0.0.1:1', 'ui-token-should-never-appear', 'http://127.0.0.1:1');
    // Same masking env TaskPaneEnvironmentService.buildEnvForNewWindow emits
    // in scoped-auth mode: an explicit empty override plus the task token.
    await tmuxClient.splitPane(LOCAL_SERVER, target, 'v', { AZITO_UI_TOKEN: '', AZITO_TASK_TOKEN: 'azt.task.42.' + 'a'.repeat(64) });

    const paneIds = tmux('list-panes', '-t', target, '-F', '#{pane_id}').trim().split('\n');
    expect(paneIds.length).toBe(2);
    const newPaneId = paneIds[1];
    await waitForPane(newPaneId, (text) => text.trim().length > 0);
    tmux('send-keys', '-t', newPaneId, 'echo "TOKENS=[$AZITO_UI_TOKEN][$AZITO_TASK_TOKEN]"', 'Enter');
    const captured = await waitForPane(newPaneId, (text) => /^TOKENS=/m.test(text));

    expect(captured).toContain('TOKENS=[][azt.task.42.');
    expect(captured).not.toContain('leaked-full-power-token');
  });
});

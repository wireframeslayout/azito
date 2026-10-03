import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockWebSocket } from './agentTransportMockWs.js';

// Issue #239: `openTerminal()` の 15 秒タイムアウトで `terminate()` を呼ぶと、CONNECTING 中の
// `ws` は 'error' を emit する。リスナーが無いと unhandled 'error' event でプロセスが落ちる。
vi.mock('ws', async () => {
  const { MockWebSocket: M } = await import('./agentTransportMockWs.js');
  return { default: M };
});

import { AgentTransport } from '../AgentTransport';

describe('AgentTransport.openTerminal timeout (Issue #239)', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with "openTerminal timed out" and does not raise an unhandled error when terminate() emits error', async () => {
    const transport = new AgentTransport('agent.invalid', 3002, 'token', 'system', 'srv');
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);
    try {
      const p = transport.openTerminal({ kind: 'tmux', workspace: 'azito', window: 'win--x' }, 1 as never, 80, 24);
      const settled = p.then(() => 'resolved', (e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await settled).toBe('openTerminal timed out');
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(MockWebSocket.instances[0].terminateCalls).toBe(1);
      // terminate() emitted 'error' synchronously above; a listener must have absorbed it.
      expect(MockWebSocket.instances[0].listenerCount('error')).toBeGreaterThan(0);
      await Promise.resolve();
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', uncaught);
    }
  });

  it('resolves on open and detaches the pre-open error handler', async () => {
    const transport = new AgentTransport('agent.invalid', 3002, 'token', 'system', 'srv');
    const p = transport.openTerminal({ kind: 'tmux', workspace: 'azito', window: 'win--x' }, 1 as never, 80, 24);
    const ws = MockWebSocket.instances[0];
    ws.emit('open');
    await expect(p).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ws.terminateCalls).toBe(0);
  });
});

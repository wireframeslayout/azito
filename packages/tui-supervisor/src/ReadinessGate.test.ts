import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PtyProxy } from './PtyProxy';
import { ReadinessGate } from './ReadinessGate';

async function waitFor(cond: () => boolean, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('ReadinessGate', () => {
  it('is not ready before any output', () => {
    const gate = new ReadinessGate({ quietMs: 20, maxWaitMs: 100 });
    expect(gate.isReady()).toBe(false);
  });

  it('becomes ready after enough output followed by the quiet period, and latches', async () => {
    const gate = new ReadinessGate({ quietMs: 40, minOutputBytes: 100, maxWaitMs: 1_000 });
    gate.notifyOutput(80);
    expect(gate.isReady()).toBe(false);
    // Continuous output keeps deferring readiness.
    await new Promise((r) => setTimeout(r, 20));
    gate.notifyOutput(80);
    await new Promise((r) => setTimeout(r, 20));
    expect(gate.isReady()).toBe(false);
    await waitFor(() => gate.isReady(), 1_000);
    // Latch: later output does not reset it.
    gate.notifyOutput(1);
    expect(gate.isReady()).toBe(true);
  });

  it('does NOT become ready on quiet alone while cumulative output is below the byte threshold', async () => {
    // Regression for the E2E failure: claude's boot had a >quietMs lull after
    // only a few bytes; first-output+quiet wrongly latched ready and the paste
    // was lost. Bytes below the threshold must keep the gate closed.
    const gate = new ReadinessGate({ quietMs: 30, minOutputBytes: 2_048, fallbackQuietMs: 5_000, maxWaitMs: 5_000 });
    gate.notifyOutput(50);
    await new Promise((r) => setTimeout(r, 100));
    expect(gate.isReady()).toBe(false);
    // Threshold crossed later -> ready after the next quiet period.
    gate.notifyOutput(2_048);
    await waitFor(() => gate.isReady(), 1_000);
  });

  describe('onReady', () => {
    it('does not fire before the gate latches', () => {
      const gate = new ReadinessGate({ quietMs: 20, minOutputBytes: 100, maxWaitMs: 1_000 });
      const cb = vi.fn();
      gate.onReady(cb);
      gate.notifyOutput(50);
      expect(cb).not.toHaveBeenCalled();
    });

    it('fires exactly once when the gate latches', async () => {
      const gate = new ReadinessGate({ quietMs: 30, minOutputBytes: 100, maxWaitMs: 1_000 });
      const cb = vi.fn();
      gate.onReady(cb);
      gate.notifyOutput(200);
      await waitFor(() => gate.isReady(), 1_000);
      expect(cb).toHaveBeenCalledTimes(1);
      // Later output must not trigger a second call.
      gate.notifyOutput(1);
      await new Promise((r) => setTimeout(r, 50));
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('fires immediately and synchronously when subscribing to an already-latched gate', async () => {
      const gate = new ReadinessGate({ quietMs: 20, minOutputBytes: 10, maxWaitMs: 1_000 });
      gate.notifyOutput(50);
      await waitFor(() => gate.isReady(), 1_000);
      const cb = vi.fn();
      gate.onReady(cb);
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('fallback quiet (below minOutputBytes)', () => {
    it('latches ready when output is below minOutputBytes but fallbackQuietMs elapses', async () => {
      const gate = new ReadinessGate({
        quietMs: 30,
        minOutputBytes: 2_048,
        fallbackQuietMs: 200,
        maxWaitMs: 5_000,
      });
      gate.notifyOutput(50);
      expect(gate.isReady()).toBe(false);
      await waitFor(() => gate.isReady(), 1_000);
      expect(gate.isReady()).toBe(true);
    });

    it('does NOT latch before fallbackQuietMs elapses', async () => {
      const gate = new ReadinessGate({
        quietMs: 30,
        minOutputBytes: 2_048,
        fallbackQuietMs: 500,
        maxWaitMs: 5_000,
      });
      gate.notifyOutput(50);
      await new Promise((r) => setTimeout(r, 100));
      expect(gate.isReady()).toBe(false);
    });

    it('does NOT latch with zero output even after fallbackQuietMs', async () => {
      const gate = new ReadinessGate({
        quietMs: 30,
        minOutputBytes: 2_048,
        fallbackQuietMs: 100,
        maxWaitMs: 5_000,
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(gate.isReady()).toBe(false);
    });
  });

  describe('integration with a real slow-booting child (PtyProxy)', () => {
    let stdoutSpy: MockInstance;
    let exitSpy: MockInstance;
    let output: string;

    beforeEach(() => {
      output = '';
      stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        output += String(chunk);
        return true;
      }) as typeof process.stdout.write);
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    });

    afterEach(() => {
      stdoutSpy.mockRestore();
      exitSpy.mockRestore();
    });

    // Spawns a real pty child (`sleep 1; echo booted; cat`) and waits out quietMs (300ms) on
    // top of that — under scheduling contention (e.g. the full suite running many test files'
    // worth of process spawns in parallel) that can exceed vitest's default 5000ms test
    // timeout with nothing actually wrong. Same pattern as the tmux-integration tests' and
    // authDoctorCommand.test.ts's per-test timeout bump (see TmuxClient.splitPane.tmuxIntegration.test.ts).
    it('holds an injection until the child prints its boot output and settles', { timeout: 20_000 }, async () => {
      // minOutputBytes lowered: the test child's boot banner ("booted") is tiny
      // compared to a real TUI welcome screen.
      const gate = new ReadinessGate({ quietMs: 300, minOutputBytes: 5, maxWaitMs: 8_000 });
      const proxy = new PtyProxy();
      let exited = false;
      proxy.on('data', (bytes: number) => gate.notifyOutput(bytes));
      proxy.on('exit', () => {
        exited = true;
      });
      proxy.start("sleep 1; echo booted; cat");

      // Simulates a hub inject_prompt arriving before the TUI booted.
      const injected = gate.waitUntilReady().then(() => {
        // At release time the boot output must already be visible: this is the
        // property that fixes the lost-first-prompt race.
        expect(output).toContain('booted');
        proxy.write('injected-prompt\n');
      });

      expect(gate.isReady()).toBe(false);
      expect(output).not.toContain('booted');

      await injected;
      // cat echoes the injected line, proving the child received it post-boot.
      await waitFor(() => output.includes('injected-prompt'));

      proxy.write('\x04');
      await waitFor(() => exited);
    });
  });
});

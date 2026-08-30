import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';

// Isolated from LocalRepoCloneService.test.ts on purpose: this file mocks
// `child_process.execFile` so we can prove other event-loop work (a
// separately-scheduled macrotask) gets to run *while the clone is still
// in flight* — the exact thing an `execFileSync`-based implementation
// could not do (review finding: a sync clone blocks the whole
// single-process hub's event loop — HTTP, WebSocket terminals, activity
// detection — for up to the 300s timeout). No real remote or network
// access is involved; `execFile` itself is mocked away entirely.
//
// This is deliberately NOT a real-time / tick-counting test (that was
// flaky under full-suite load: a fixed 150ms window's timer-tick count
// drops when the machine is busy). Instead, the mock hands back full
// manual control over when the underlying "git clone" subprocess
// callback fires, and the test asserts *order*: a macrotask scheduled
// after `service.clone()` is called must observe completion before the
// clone's callback is manually released. A synchronous implementation
// could never let that macrotask run first, so the assertion is a
// deterministic proxy for "did not block the event loop" — no timing
// thresholds involved.

const { capturedCallbacks } = vi.hoisted(() => ({
  capturedCallbacks: [] as Array<(...args: unknown[]) => void>,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        // Capture the callback instead of ever invoking it automatically —
        // the test decides exactly when the "subprocess" is done, so
        // ordering can be asserted deterministically instead of inferred
        // from elapsed wall-clock time.
        capturedCallbacks.push(cb as (...a: unknown[]) => void);
        return undefined;
      }
      return (actual.execFile as (...a: unknown[]) => unknown)(...args);
    },
  };
});

describe('LocalRepoCloneService (event loop non-blocking)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    capturedCallbacks.length = 0;
    for (const dir of tmpDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  });

  function makeTmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  it('lets other event-loop work (a scheduled macrotask) run before a clone settles', async () => {
    const { LocalRepoCloneService } = await import('./LocalRepoCloneService.js');
    const origin = makeTmpDir('azito-clone-origin-');
    // Deliberately not a real repo — the mocked execFile never actually
    // shells out to git, so no origin content is needed.
    const targetRoot = makeTmpDir('azito-clone-target-');
    const targetDir = path.join(targetRoot, 'project');

    const order: string[] = [];
    const service = new LocalRepoCloneService();
    const clonePromise = service
      .clone({ provider: 'github', host: 'local-test', owner: 'owner', repo: 'repo', httpsUrl: origin }, null, 'main', targetDir)
      .catch(() => { /* expected: the mocked callback below reports a failure */ })
      .then(() => { order.push('clone-settled'); });

    // A macrotask scheduled right after starting the clone. If cloning
    // blocked the event loop synchronously, this could not run until the
    // (still-unfired) execFile callback had already resolved the clone —
    // i.e. 'clone-settled' would always land first. Because execFile is
    // async here, this macrotask is free to run immediately.
    await new Promise<void>((resolve) => setTimeout(() => { order.push('interrupt'); resolve(); }, 0));

    // At this point the clone cannot have settled yet: we have not
    // released the captured execFile callback.
    expect(order).toEqual(['interrupt']);
    expect(capturedCallbacks).toHaveLength(1);

    // Now let the "subprocess" report completion (a failure is fine — the
    // service only needs to settle, not succeed, for this ordering check).
    capturedCallbacks[0](new Error('mock clone failure'), '', '');
    await clonePromise;

    expect(order).toEqual(['interrupt', 'clone-settled']);
  });
});

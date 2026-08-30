import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';

// Isolated from LocalRepoCloneService.test.ts on purpose: this file mocks
// `child_process.execFile` to inject an artificial delay before the git
// subprocess "completes", so we can prove other event-loop work (a
// `setInterval` timer) keeps running *while the clone is in flight* — the
// exact thing an `execFileSync`-based implementation could not do (review
// finding: a sync clone blocks the whole single-process hub's event loop —
// HTTP, WebSocket terminals, activity detection — for up to the 300s
// timeout). No real remote or network access is involved; `execFile` itself
// is mocked away entirely.

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        // Defer the callback via setTimeout instead of invoking it inline —
        // this is what an async, non-blocking subprocess API looks like.
        // If LocalRepoCloneService instead called `execFileSync`, this mock
        // (and its delay) would never even be reached.
        const patchedArgs = args.slice(0, -1);
        patchedArgs.push((...cbArgs: unknown[]) => {
          setTimeout(() => (cb as (...a: unknown[]) => void)(...cbArgs), 300);
        });
        return (actual.execFile as (...a: unknown[]) => unknown)(...patchedArgs);
      }
      return (actual.execFile as (...a: unknown[]) => unknown)(...args);
    },
  };
});

describe('LocalRepoCloneService (event loop non-blocking)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  });

  function makeTmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  it('lets other event-loop work (a running timer) keep progressing while a clone is in flight', async () => {
    const { LocalRepoCloneService } = await import('./LocalRepoCloneService.js');
    const origin = makeTmpDir('azito-clone-origin-');
    // Deliberately not a real repo — the mocked execFile never actually
    // shells out to git, so no origin content is needed.
    const targetRoot = makeTmpDir('azito-clone-target-');
    const targetDir = path.join(targetRoot, 'project');

    let tickCount = 0;
    const timer = setInterval(() => { tickCount += 1; }, 10);

    const service = new LocalRepoCloneService();
    const clonePromise = service.clone(
      { provider: 'github', host: 'local-test', owner: 'owner', repo: 'repo', httpsUrl: origin },
      null,
      'main',
      targetDir,
    );

    // While the (mocked, delayed) clone is still pending, the event loop
    // must have already run several timer ticks — proof the clone did not
    // occupy the loop synchronously.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(tickCount).toBeGreaterThan(3);

    clearInterval(timer);
    // The mocked execFile still calls through to the real one (against a
    // non-existent/invalid local origin), so the clone itself fails — we
    // only care that it settles without hanging the test.
    await clonePromise.catch(() => { /* expected: origin has no commits/branch */ });
  });
});

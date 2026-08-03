import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync } from 'zlib';
import {
  SidekickSyncService,
  computeSidekicksHash,
  resolveSidekickDir,
  REMOTE_SIDEKICKS_BASE,
  PAYLOAD_CHUNK_SIZE,
} from './SidekickSyncService';
import type { IServerTransport } from '../servers/transport/ServerTransport';
import type { SidekickPackage } from './SidekickPackage';

function makePackage(overrides: Partial<SidekickPackage> = {}): SidekickPackage {
  return {
    name: 'azt-implement',
    description: 'implement',
    tags: ['implementing'],
    isDefault: true,
    layer: 'builtin',
    overridesBuiltin: false,
    dir: '/tmp/does-not-matter',
    body: 'body',
    hasScripts: true,
    hasReferences: false,
    ...overrides,
  };
}

function writeTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/** Echoes back any success marker the command asks for (happy-path remote shell). */
function echoMarker(cmd: string): string {
  const m = cmd.match(/AZITO_(?:LOCK|CHUNK|SYNC)_OK_[0-9a-f]+/);
  return m ? m[0] : '';
}

interface TransportOverrides {
  /** Per-command interception; return undefined to fall through to the default happy path. */
  onExec?: (cmd: string) => { stdout: string; stderr: string; code: number } | undefined;
  /** stdout returned for the initial hash read (default: 'stale-hash' → transfer proceeds). */
  remoteHash?: string;
  /** Awaited before answering any command (used to hold a sync in flight). */
  gate?: (cmd: string) => Promise<void>;
}

function makeTransport(overrides: TransportOverrides = {}) {
  const exec = vi.fn(async (cmd: string) => {
    if (overrides.gate) await overrides.gate(cmd);
    const intercepted = overrides.onExec?.(cmd);
    if (intercepted) return intercepted;
    if (cmd.startsWith('cat ')) {
      return { stdout: overrides.remoteHash ?? 'stale-hash', stderr: '', code: 0 };
    }
    return { stdout: echoMarker(cmd), stderr: '', code: 0 };
  });
  const transport = { exec, execTmux: vi.fn(), openTerminal: vi.fn(), createPaneStream: vi.fn() } as unknown as IServerTransport;
  return { transport, exec };
}

function commandsOf(exec: ReturnType<typeof vi.fn>): string[] {
  return exec.mock.calls.map((c) => c[0] as string);
}

const fastOpts = { lockRetries: 3, lockRetryDelayMs: 0 };

describe('computeSidekicksHash', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-hash-test-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-hash-test-b-'));
  });

  afterEach(() => {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('is deterministic regardless of package list order', () => {
    writeTree(dirA, { 'SKILL.md': 'a', 'scripts/push.sh': 'echo a' });
    writeTree(dirB, { 'SKILL.md': 'b' });

    const pkgA = makePackage({ name: 'pkg-a', dir: dirA });
    const pkgB = makePackage({ name: 'pkg-b', dir: dirB });

    expect(computeSidekicksHash([pkgA, pkgB])).toBe(computeSidekicksHash([pkgB, pkgA]));
  });

  it('is deterministic across repeated computations within a package', () => {
    writeTree(dirA, { 'a.md': '1', 'z.md': '2', 'scripts/b.sh': '3', 'scripts/a.sh': '4' });
    const pkg = makePackage({ name: 'pkg', dir: dirA });

    expect(computeSidekicksHash([pkg])).toBe(computeSidekicksHash([pkg]));
  });

  it('changes when file content changes', () => {
    writeTree(dirA, { 'SKILL.md': 'v1' });
    const pkg = makePackage({ name: 'pkg', dir: dirA });
    const before = computeSidekicksHash([pkg]);

    fs.writeFileSync(path.join(dirA, 'SKILL.md'), 'v2');

    expect(computeSidekicksHash([pkg])).not.toBe(before);
  });

  it('changes when a file is added', () => {
    writeTree(dirA, { 'SKILL.md': 'v1' });
    const pkg = makePackage({ name: 'pkg', dir: dirA });
    const before = computeSidekicksHash([pkg]);

    writeTree(dirA, { 'references/extra.md': 'extra' });

    expect(computeSidekicksHash([pkg])).not.toBe(before);
  });
});

describe('resolveSidekickDir', () => {
  const pkg = makePackage({ name: 'azt-implement', dir: '/harness/sidekicks/azt-implement' });

  it('returns pkg.dir for a local server', () => {
    expect(resolveSidekickDir(pkg, { type: 'local' })).toBe('/harness/sidekicks/azt-implement');
  });

  it('returns the remote flat path for an ssh server', () => {
    expect(resolveSidekickDir(pkg, { type: 'agent' })).toBe(`${REMOTE_SIDEKICKS_BASE}/azt-implement`);
  });

  it('returns the remote flat path for an agent server', () => {
    expect(resolveSidekickDir(pkg, { type: 'agent' })).toBe(`${REMOTE_SIDEKICKS_BASE}/azt-implement`);
  });
});

describe('SidekickSyncService.sync', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-sync-test-'));
    writeTree(dir, { 'SKILL.md': 'body', 'scripts/push.sh': '#!/bin/bash\necho push' });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips the transfer when the remote hash already matches', async () => {
    const pkg = makePackage({ name: 'pkg', dir });
    const hash = computeSidekicksHash([pkg]);
    const { transport, exec } = makeTransport({ remoteHash: hash });

    await new SidekickSyncService(fastOpts).sync('myserver', transport, [pkg]);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(commandsOf(exec)[0]).toContain('cat');
  });

  it('transfers when the remote hash differs: lock → chunked upload → staged extract/swap → unlock', async () => {
    const pkg = makePackage({ name: 'pkg', dir });
    const { transport, exec } = makeTransport();

    await new SidekickSyncService(fastOpts).sync('myserver', transport, [pkg]);

    const cmds = commandsOf(exec);
    // cat, lock, 1 chunk (tiny package), extract/swap, unlock
    expect(cmds).toHaveLength(5);
    expect(cmds[1]).toContain('mkdir ~/.azito/sidekicks.lock');
    expect(cmds[2]).toMatch(/^printf '%s' '[A-Za-z0-9+/=]+' > ~\/\.azito\/sidekicks-payload\./);
    expect(cmds[3]).toContain('base64 -d <');
    expect(cmds[3]).toContain('tar xzf -');
    expect(cmds[3]).toContain('chmod -R 755');
    expect(cmds[3]).toContain('.azito-sidekicks-hash');
    expect(cmds[4]).toBe('rm -rf ~/.azito/sidekicks.lock');
  });

  it('stages into a tmp dir and swaps at the very end (rm -rf base && mv tmp base are the last mutations)', async () => {
    const pkg = makePackage({ name: 'pkg', dir });
    const { transport, exec } = makeTransport();

    await new SidekickSyncService(fastOpts).sync('myserver', transport, [pkg]);

    const extractCmd = commandsOf(exec).find((c) => c.includes('tar xzf'))!;
    const steps = extractCmd.split(' && ');
    expect(steps[0]).toMatch(/^mkdir -p ~\/\.azito\/sidekicks\.tmp\.[0-9a-f]+$/);
    expect(steps.at(-3)).toBe(`rm -rf ${REMOTE_SIDEKICKS_BASE}`);
    expect(steps.at(-2)).toMatch(/^mv ~\/\.azito\/sidekicks\.tmp\.[0-9a-f]+ ~\/\.azito\/sidekicks$/);
    expect(steps.at(-1)).toMatch(/^echo AZITO_SYNC_OK_[0-9a-f]+$/);
    // Everything before the swap works on tmp/payload paths only — the live
    // base dir is never touched until extraction/chmod/hash all succeeded.
    for (const step of steps.slice(0, -3)) {
      expect(step).toMatch(/sidekicks\.tmp\.|sidekicks-payload\./);
    }
  });

  it('throws (fail fast) when the extract/swap marker is missing even with code 0 (SSH-style silent failure)', async () => {
    const pkg = makePackage({ name: 'pkg', dir });
    const { transport } = makeTransport({
      onExec: (cmd) => (cmd.includes('tar xzf') ? { stdout: '', stderr: '', code: 0 } : undefined),
    });

    await expect(new SidekickSyncService(fastOpts).sync('myserver', transport, [pkg]))
      .rejects.toThrow(/Sidekick sync to server "myserver" failed \(extract\/swap\)/);
  });

  it('throws with stderr detail on non-zero exit, and cleans up staging artifacts + lock', async () => {
    const pkg = makePackage({ name: 'pkg', dir });
    const { transport, exec } = makeTransport({
      onExec: (cmd) => (cmd.includes('tar xzf') ? { stdout: '', stderr: 'tar: unexpected EOF', code: 1 } : undefined),
    });

    await expect(new SidekickSyncService(fastOpts).sync('myserver', transport, [pkg]))
      .rejects.toThrow(/tar: unexpected EOF/);

    const cmds = commandsOf(exec);
    expect(cmds.some((c) => /^rm -rf ~\/\.azito\/sidekicks\.tmp\.[0-9a-f]+ ~\/\.azito\/sidekicks-payload\./.test(c))).toBe(true);
    expect(cmds.at(-1)).toBe('rm -rf ~/.azito/sidekicks.lock');
  });

  it('throws when a chunk upload marker is missing (fail fast before touching the live tree)', async () => {
    const pkg = makePackage({ name: 'pkg', dir });
    const { transport, exec } = makeTransport({
      onExec: (cmd) => (cmd.startsWith('printf') ? { stdout: '', stderr: '', code: 0 } : undefined),
    });

    await expect(new SidekickSyncService(fastOpts).sync('myserver', transport, [pkg]))
      .rejects.toThrow(/payload upload/);
    expect(commandsOf(exec).some((c) => c.includes('tar xzf'))).toBe(false);
  });

  describe('remote lock', () => {
    it('retries lock acquisition and succeeds on a later attempt', async () => {
      const pkg = makePackage({ name: 'pkg', dir });
      let lockAttempts = 0;
      const { transport, exec } = makeTransport({
        onExec: (cmd) => {
          if (cmd.startsWith('if mkdir')) {
            lockAttempts++;
            if (lockAttempts === 1) return { stdout: '', stderr: '', code: 0 }; // held by someone else
          }
          return undefined;
        },
      });

      await new SidekickSyncService(fastOpts).sync('myserver', transport, [pkg]);

      expect(lockAttempts).toBe(2);
      expect(commandsOf(exec).some((c) => c.includes('tar xzf'))).toBe(true);
    });

    it('gives up after the configured retries and throws without transferring', async () => {
      const pkg = makePackage({ name: 'pkg', dir });
      const { transport, exec } = makeTransport({
        onExec: (cmd) => (cmd.startsWith('if mkdir') ? { stdout: '', stderr: '', code: 0 } : undefined),
      });

      await expect(new SidekickSyncService({ lockRetries: 2, lockRetryDelayMs: 0 }).sync('myserver', transport, [pkg]))
        .rejects.toThrow(/could not acquire remote lock/);

      const cmds = commandsOf(exec);
      expect(cmds.filter((c) => c.startsWith('if mkdir'))).toHaveLength(2);
      expect(cmds.some((c) => c.startsWith('printf') || c.includes('tar xzf'))).toBe(false);
    });

    it('the lock command carries stale-takeover logic (timestamp check + forced re-acquire)', async () => {
      const pkg = makePackage({ name: 'pkg', dir });
      const { transport, exec } = makeTransport();

      await new SidekickSyncService(fastOpts).sync('myserver', transport, [pkg]);

      const lockCmd = commandsOf(exec).find((c) => c.startsWith('if mkdir'))!;
      expect(lockCmd).toContain('date +%s > ~/.azito/sidekicks.lock/ts');
      expect(lockCmd).toContain('cat ~/.azito/sidekicks.lock/ts');
      expect(lockCmd).toContain('-gt 300');
      expect(lockCmd).toContain('rm -rf ~/.azito/sidekicks.lock');
    });
  });

  describe('payload chunking', () => {
    it('splits a large payload into PAYLOAD_CHUNK_SIZE chunks that reassemble to the exact original', async () => {
      // ~200KB of incompressible data → base64(tar.gz) is guaranteed > 2 chunks of 48KB.
      const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-sync-big-'));
      try {
        writeTree(bigDir, { 'SKILL.md': 'body', 'references/blob.bin': crypto.randomBytes(200 * 1024) });
        const pkg = makePackage({ name: 'big', dir: bigDir });
        const { transport, exec } = makeTransport();

        await new SidekickSyncService(fastOpts).sync('myserver', transport, [pkg]);

        const chunkCmds = commandsOf(exec).filter((c) => c.startsWith('printf'));
        expect(chunkCmds.length).toBeGreaterThan(1);
        const chunks = chunkCmds.map((c) => c.match(/^printf '%s' '([A-Za-z0-9+/=]*)'/)![1]);
        // Boundary: every chunk except the last is exactly PAYLOAD_CHUNK_SIZE;
        // the last is non-empty and no larger.
        for (const chunk of chunks.slice(0, -1)) expect(chunk).toHaveLength(PAYLOAD_CHUNK_SIZE);
        expect(chunks.at(-1)!.length).toBeGreaterThan(0);
        expect(chunks.at(-1)!.length).toBeLessThanOrEqual(PAYLOAD_CHUNK_SIZE);
        // Only the first chunk truncates; the rest append.
        expect(chunkCmds[0]).toContain("' > ~/");
        for (const c of chunkCmds.slice(1)) expect(c).toContain("' >> ~/");
        // The reassembled payload is the valid gzip archive we built (magic 1f 8b).
        const payload = Buffer.from(chunks.join(''), 'base64');
        expect(payload[0]).toBe(0x1f);
        expect(payload[1]).toBe(0x8b);
        expect(() => gunzipSync(payload)).not.toThrow();
      } finally {
        fs.rmSync(bigDir, { recursive: true, force: true });
      }
    });
  });

  describe('hub-side in-flight deduplication', () => {
    it('concurrent sync calls for the same server share one transfer', async () => {
      const pkg = makePackage({ name: 'pkg', dir });
      let releaseGate!: () => void;
      const gatePromise = new Promise<void>((resolve) => { releaseGate = resolve; });
      const { transport, exec } = makeTransport({
        gate: (cmd) => (cmd.startsWith('cat ') ? gatePromise : Promise.resolve()),
      });

      const service = new SidekickSyncService(fastOpts);
      const first = service.sync('myserver', transport, [pkg]);
      const second = service.sync('myserver', transport, [pkg]);
      expect(second).toBe(first); // same in-flight promise, not a second transfer

      releaseGate();
      await Promise.all([first, second]);

      const cmds = commandsOf(exec);
      expect(cmds.filter((c) => c.startsWith('cat '))).toHaveLength(1);
      expect(cmds.filter((c) => c.includes('tar xzf'))).toHaveLength(1);
    });

    it('a new sync after completion starts a fresh check (in-flight entry is cleared)', async () => {
      const pkg = makePackage({ name: 'pkg', dir });
      const { transport, exec } = makeTransport();
      const service = new SidekickSyncService(fastOpts);

      await service.sync('myserver', transport, [pkg]);
      await service.sync('myserver', transport, [pkg]);

      expect(commandsOf(exec).filter((c) => c.startsWith('cat '))).toHaveLength(2);
    });

    it('different servers sync independently (no cross-server serialization)', async () => {
      const pkg = makePackage({ name: 'pkg', dir });
      const a = makeTransport();
      const b = makeTransport();
      const service = new SidekickSyncService(fastOpts);

      await Promise.all([
        service.sync('server-a', a.transport, [pkg]),
        service.sync('server-b', b.transport, [pkg]),
      ]);

      expect(commandsOf(a.exec).some((c) => c.includes('tar xzf'))).toBe(true);
      expect(commandsOf(b.exec).some((c) => c.includes('tar xzf'))).toBe(true);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync } from 'zlib';
import {
  SidekickSyncService,
  computeSidekicksHash,
  buildTarball,
  resolveSidekickDir,
  resolveSidekickDirOnHost,
  resolveSidekickNodeOnHost,
  REMOTE_SIDEKICKS_BASE,
  PAYLOAD_CHUNK_SIZE,
} from './SidekickSyncService';
import type { IServerTransport } from '../servers/transport/ServerTransport';
import { ShellFileOps } from '../servers/transport/ShellFileOps';
import { LocalFileOps, localFileOpsHost } from '../../shared/fs/LocalFileOps';
import { runCommandSpec } from '../../shared/exec/runCommandSpec';
import { CommandSpawnError, type CommandResult, type CommandSpec } from '../../shared/exec/commandSpec';
import { unpackTarGz } from '../../shared/fs/tarGz';
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
  // An agent whose OS was never recorded: its files() is the shell implementation, which selects the shell route of the sync.
  const transport = { exec, files: () => new ShellFileOps({ exec }), execMux: vi.fn(), openTerminal: vi.fn(), createPaneStream: vi.fn() } as unknown as IServerTransport;
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

describe('buildTarball', () => {
  it('states the modes itself: files under scripts/ are executable, the rest are not, whatever the hub file system reports', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-tar-'));
    try {
      writeTree(root, { 'SKILL.md': 'body', 'references/r.md': 'ref', 'scripts/push.sh': '#!/bin/bash\n', 'scripts/lib/helper.sh': 'x' });
      fs.chmodSync(path.join(root, 'scripts', 'push.sh'), 0o644);
      const entries = unpackTarGz(buildTarball([{ name: 'pkg', dir: root }]));
      const modes = Object.fromEntries(entries.map((e) => [e.path, e.mode.toString(8)]));
      expect(modes).toEqual({
        pkg: '755',
        'pkg/SKILL.md': '644',
        'pkg/references': '755',
        'pkg/references/r.md': '644',
        'pkg/scripts': '755',
        'pkg/scripts/lib': '755',
        'pkg/scripts/lib/helper.sh': '755',
        'pkg/scripts/push.sh': '755',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

describe('resolveSidekickDirOnHost', () => {
  const pkg = makePackage({ name: 'pushing-default', dir: 'C:\\hub\\harness\\sidekicks\\pushing-default' });
  const factory = (platform: 'linux' | 'win32' | null, home = '/home/me') => ({
    hostProfileFor: () => (platform ? { platform, arch: 'x64' } : null),
    getFileOps: () => ({ realpath: async () => home }),
  }) as never;

  it('a POSIX host keeps ~ for its shell to expand, a local one its own directory', async () => {
    expect(await resolveSidekickDirOnHost(pkg, { type: 'agent' }, factory('linux'))).toBe(`${REMOTE_SIDEKICKS_BASE}/pushing-default`);
    expect(await resolveSidekickDirOnHost(pkg, { type: 'agent' }, factory(null))).toBe(`${REMOTE_SIDEKICKS_BASE}/pushing-default`);
    expect(await resolveSidekickDirOnHost(pkg, { type: 'local' }, factory('linux'))).toBe(pkg.dir);
  });

  it("a Windows agent's directory is written out under its home, with forward slashes", async () => {
    expect(await resolveSidekickDirOnHost(pkg, { type: 'agent' }, factory('win32', 'C:\\Users\\me'))).toBe('C:/Users/me/.azito/sidekicks/pushing-default');
  });

  it("a Windows hub's own server uses the hub's package directory with forward slashes", async () => {
    expect(await resolveSidekickDirOnHost(pkg, { type: 'local' }, factory('win32'))).toBe('C:/hub/harness/sidekicks/pushing-default');
  });
});

describe('resolveSidekickNodeOnHost ({{host.node}})', () => {
  const usesNode = { body: 'run {{host.node}} "x.mjs"' };
  const noNode = { body: 'no scripts here' };
  const factory = (platform: 'linux' | 'win32' | null, nodePath = 'C:\\Program Files\\nodejs\\node.exe') => ({
    hostProfileFor: () => (platform ? { platform, arch: 'x64' } : null),
    getAgentTransport: () => ({ fetchNodeExecPath: async () => nodePath }),
  }) as never;

  it('is not asked of an agent that cannot report it when the body does not use it, and is an explicit error when the body does', async () => {
    const old = { hostProfileFor: () => ({ platform: 'win32', arch: 'x64' }), getAgentTransport: () => ({ fetchNodeExecPath: async () => { throw new Error('did not report its node executable; update the agent'); } }) } as never;
    expect(await resolveSidekickNodeOnHost(noNode, { type: 'agent' }, old)).toBe('node');
    await expect(resolveSidekickNodeOnHost(usesNode, { type: 'agent' }, old)).rejects.toThrow(/update the agent/);
  });

  it('is a bare node on a POSIX host (and one whose OS is not recorded)', async () => {
    expect(await resolveSidekickNodeOnHost(usesNode, { type: 'agent' }, factory('linux'))).toBe('node');
    expect(await resolveSidekickNodeOnHost(usesNode, { type: 'agent' }, factory(null))).toBe('node');
  });

  it("is the Windows agent's own node.exe by full path in double quotes", async () => {
    expect(await resolveSidekickNodeOnHost(usesNode, { type: 'agent' }, factory('win32'))).toBe('"C:/Program Files/nodejs/node.exe"');
  });

  it("is the hub's own node for a Windows hub's local server, and refuses a path the shell would read inside quotes", async () => {
    expect(await resolveSidekickNodeOnHost(usesNode, { type: 'local' }, factory('win32'))).toBe(`"${process.execPath.replace(/\\/g, '/')}"`);
    await expect(resolveSidekickNodeOnHost(usesNode, { type: 'agent' }, factory('win32', 'C:\\no$de\\node.exe'))).rejects.toThrow(/node executable/);
  });
});

describe('SidekickSyncService.sync (an agent without file operations: shell commands)', () => {
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

describe('SidekickSyncService.sync (file operations + run)', () => {
  let dir: string;
  let home: string;
  let specs: CommandSpec[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-sync-ops-'));
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'azito-sync-home-')));
    // 644 on purpose: the sync is what makes a script runnable.
    writeTree(dir, { 'SKILL.md': 'body', 'scripts/push.sh': '#!/bin/bash\necho push', 'references/r.md': 'ref' });
    fs.chmodSync(path.join(dir, 'scripts', 'push.sh'), 0o644);
    specs = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** The hub's own host: real files under a temporary home, and a real `tar`. `onRun` may answer a spec itself. */
  function makeHost(onRun?: (spec: CommandSpec) => CommandResult | undefined): IServerTransport {
    const files = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: home }));
    return {
      files: () => files,
      run: async (spec: CommandSpec) => {
        specs.push(spec);
        return onRun?.(spec) ?? runCommandSpec(spec, { windows: process.platform === 'win32', systemRoot: process.env.SystemRoot } as Parameters<typeof runCommandSpec>[1]);
      },
      exec: vi.fn(async () => { throw new Error('the file operations route must not use a shell'); }),
    } as unknown as IServerTransport;
  }

  const sidekicksDir = (): string => path.join(home, '.azito', 'sidekicks');
  const leftovers = (): string[] => fs.readdirSync(path.join(home, '.azito')).filter((name) => name !== 'sidekicks');

  it('extracts the packages into ~/.azito/sidekicks with the hash marker, and leaves no payload, staging or lock behind', async () => {
    const pkg = makePackage({ name: 'pkg', dir });

    await new SidekickSyncService(fastOpts).sync('myserver', makeHost(), [pkg]);

    expect(fs.readFileSync(path.join(sidekicksDir(), 'pkg', 'SKILL.md'), 'utf8')).toBe('body');
    expect(fs.readFileSync(path.join(sidekicksDir(), 'pkg', 'references', 'r.md'), 'utf8')).toBe('ref');
    expect(fs.readFileSync(path.join(sidekicksDir(), '.azito-sidekicks-hash'), 'utf8').trim()).toBe(computeSidekicksHash([pkg]));
    expect(leftovers()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('makes the scripts executable, as chmod -R 755 on scripts/ did', async () => {
    await new SidekickSyncService(fastOpts).sync('myserver', makeHost(), [makePackage({ name: 'pkg', dir })]);

    expect(fs.statSync(path.join(sidekicksDir(), 'pkg', 'scripts', 'push.sh')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(sidekicksDir(), 'pkg', 'SKILL.md')).mode & 0o111).toBe(0);
  });

  it('runs tar without a shell, in ~/.azito, with relative paths only (no drive letter reaches its arguments)', async () => {
    await new SidekickSyncService(fastOpts).sync('myserver', makeHost(), [makePackage({ name: 'pkg', dir })]);

    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ file: 'tar', cwd: path.join(home, '.azito') });
    expect(specs[0].args).toEqual(['xzf', expect.stringMatching(/^sidekicks-payload\.[0-9a-f]+\.tar\.gz$/), '-C', expect.stringMatching(/^sidekicks\.tmp\.[0-9a-f]+$/)]);
  });

  it('skips the transfer when the host already holds this hash', async () => {
    const pkg = makePackage({ name: 'pkg', dir });
    const service = new SidekickSyncService(fastOpts);
    await service.sync('myserver', makeHost(), [pkg]);
    specs.length = 0;

    await service.sync('myserver', makeHost(), [pkg]);

    expect(specs).toEqual([]);
  });

  it('replaces a previous tree with the new one', async () => {
    const service = new SidekickSyncService(fastOpts);
    const pkg = makePackage({ name: 'pkg', dir });
    await service.sync('myserver', makeHost(), [pkg]);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'body v2');
    fs.rmSync(path.join(dir, 'references'), { recursive: true });

    await service.sync('myserver', makeHost(), [pkg]);

    expect(fs.readFileSync(path.join(sidekicksDir(), 'pkg', 'SKILL.md'), 'utf8')).toBe('body v2');
    expect(fs.existsSync(path.join(sidekicksDir(), 'pkg', 'references'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('keeps the previous tree, cleans up and says why when tar fails', async () => {
    const service = new SidekickSyncService(fastOpts);
    const pkg = makePackage({ name: 'pkg', dir });
    await service.sync('myserver', makeHost(), [pkg]);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'body v2');

    await expect(service.sync('myserver', makeHost(() => ({ exitCode: 1, signal: null, stdout: '', stderr: 'tar: unexpected EOF' })), [pkg]))
      .rejects.toThrow(/Sidekick sync to server "myserver" failed \(extract\): tar: unexpected EOF/);

    expect(fs.readFileSync(path.join(sidekicksDir(), 'pkg', 'SKILL.md'), 'utf8')).toBe('body');
    expect(leftovers()).toEqual([]);
  });

  it('reports a tar that cannot be started', async () => {
    const host = makeHost();
    (host as { run: unknown }).run = async () => { throw new CommandSpawnError('ENOENT', 'spawn tar ENOENT'); };

    await expect(new SidekickSyncService(fastOpts).sync('myserver', host, [makePackage({ name: 'pkg', dir })]))
      .rejects.toThrow(/failed \(extract\): spawn tar ENOENT/);
    expect(leftovers()).toEqual([]);
  });

  it('keeps the previous tree when replacing it fails, and cleans up', async () => {
    const service = new SidekickSyncService(fastOpts);
    const pkg = makePackage({ name: 'pkg', dir });
    await service.sync('myserver', makeHost(), [pkg]);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'body v2');
    const host = makeHost();
    const files = host.files();
    (host as { files: unknown }).files = () => new Proxy(files, {
      get: (target, key) => (key === 'replaceDirectory' ? async () => { throw new Error('connection lost'); } : Reflect.get(target, key).bind?.(target) ?? Reflect.get(target, key)),
    });

    await expect(service.sync('myserver', host, [pkg])).rejects.toThrow('connection lost');

    expect(fs.readFileSync(path.join(sidekicksDir(), 'pkg', 'SKILL.md'), 'utf8')).toBe('body');
    expect(leftovers()).toEqual([]);
  });

  it('swaps the live tree with one replaceDirectory request (never a separate remove of the live tree)', async () => {
    const host = makeHost();
    const files = host.files();
    const calls: string[] = [];
    (host as { files: unknown }).files = () => new Proxy(files, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { calls.push(`${String(key)}:${typeof args[0] === 'string' ? path.basename(args[0]) : ''}`); return value.apply(target, args); };
      },
    });

    await new SidekickSyncService(fastOpts).sync('myserver', host, [makePackage({ name: 'pkg', dir })]);

    expect(calls.filter((c) => c.startsWith('replaceDirectory'))).toHaveLength(1);
    expect(calls).not.toContain('remove:sidekicks');
    expect(calls).not.toContain('rename:sidekicks.tmp');
  });

  describe('remote lock', () => {
    it('gives up after the configured retries without transferring while a fresh lock is held', async () => {
      fs.mkdirSync(path.join(home, '.azito', 'sidekicks.lock'), { recursive: true });

      await expect(new SidekickSyncService({ lockRetries: 2, lockRetryDelayMs: 0 }).sync('myserver', makeHost(), [makePackage({ name: 'pkg', dir })]))
        .rejects.toThrow(/could not acquire remote lock/);

      expect(specs).toEqual([]);
      expect(fs.existsSync(path.join(home, '.azito', 'sidekicks.lock'))).toBe(true);
    });

    it('judges the lock by the age the host reports, not by its mtime against the hub clock', async () => {
      const lock = path.join(home, '.azito', 'sidekicks.lock');
      fs.mkdirSync(lock, { recursive: true });
      const host = makeHost();
      const files = host.files();
      // a host whose clock says the lock is 10 minutes old, while its mtime would look brand new to the hub
      (host as { files: unknown }).files = () => new Proxy(files, {
        get: (target, key) => (key === 'stat'
          ? async (p: string, options?: object) => { const stat = await target.stat(p, options); return stat && p === lock ? { ...stat, ageMs: 10 * 60 * 1000 } : stat; }
          : Reflect.get(target, key) instanceof Function ? (Reflect.get(target, key) as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, key)),
      });

      await new SidekickSyncService(fastOpts).sync('myserver', host, [makePackage({ name: 'pkg', dir })]);

      expect(fs.existsSync(path.join(sidekicksDir(), 'pkg', 'SKILL.md'))).toBe(true);
    });

    it('fails when the host does not report the age of the lock, instead of guessing from the clocks', async () => {
      const lock = path.join(home, '.azito', 'sidekicks.lock');
      fs.mkdirSync(lock, { recursive: true });
      const host = makeHost();
      const files = host.files();
      (host as { files: unknown }).files = () => new Proxy(files, {
        get: (target, key) => (key === 'stat'
          ? async (p: string) => { const stat = await target.stat(p); return stat && { ...stat, ageMs: undefined }; }
          : Reflect.get(target, key) instanceof Function ? (Reflect.get(target, key) as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, key)),
      });

      await expect(new SidekickSyncService(fastOpts).sync('myserver', host, [makePackage({ name: 'pkg', dir })])).rejects.toThrow(/how old the sync lock is/);
    });

    it('takes over a lock older than five minutes and releases it afterwards', async () => {
      const lock = path.join(home, '.azito', 'sidekicks.lock');
      fs.mkdirSync(lock, { recursive: true });
      const old = (Date.now() - 6 * 60 * 1000) / 1000;
      fs.utimesSync(lock, old, old);

      await new SidekickSyncService(fastOpts).sync('myserver', makeHost(), [makePackage({ name: 'pkg', dir })]);

      expect(fs.existsSync(path.join(sidekicksDir(), 'pkg', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(lock)).toBe(false);
    });
  });
});

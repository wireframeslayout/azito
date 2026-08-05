import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  isPathContained,
  assertPathContained,
  assertDirectoryContained,
  LocalPathResolver,
  RemotePathResolver,
  PathResolverFactory,
} from './PathContainment';
import type { IServerTransport, ExecResult } from '../servers/transport/ServerTransport';

function mockTransport(handler: (cmd: string) => ExecResult): IServerTransport {
  return {
    exec: vi.fn(async (cmd: string) => handler(cmd)),
    execTmux: vi.fn(),
    openTerminal: vi.fn(),
    createPaneStream: vi.fn(),
  } as unknown as IServerTransport;
}

describe('isPathContained', () => {
  it('accepts the root itself', () => {
    expect(isPathContained('/a/b', '/a/b')).toBe(true);
  });

  it('accepts a path strictly beneath the root', () => {
    expect(isPathContained('/a/b', '/a/b/c')).toBe(true);
  });

  it('rejects a sibling path that merely shares a string prefix (regression: no prefix matching)', () => {
    expect(isPathContained('/a/b', '/a/bc')).toBe(false);
    expect(isPathContained('/a/b', '/a/bc/d')).toBe(false);
  });

  it('rejects a path that escapes the root via ..', () => {
    expect(isPathContained('/a/b', '/a/b/../../etc')).toBe(false);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isPathContained('/a/b', '/etc')).toBe(false);
  });

  it('accepts a legitimate child directory whose name happens to start with ".." (regression: bare rel.startsWith(\'..\') over-rejects)', () => {
    expect(isPathContained('/a/b', '/a/b/..cache')).toBe(true);
    expect(isPathContained('/a/b', '/a/b/..cache/nested')).toBe(true);
  });
});

describe('LocalPathResolver', () => {
  it('resolves a real directory to its real path', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-'));
    try {
      const resolver = new LocalPathResolver();
      const resolved = await resolver.resolveRealPath(dir);
      expect(resolved).toBe(await new LocalPathResolver().resolveRealPath(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a path that does not exist', async () => {
    const resolver = new LocalPathResolver();
    await expect(resolver.resolveRealPath('/nonexistent/definitely-not-here-12345')).rejects.toThrow();
  });
});

describe('RemotePathResolver', () => {
  it('resolves via `realpath -e` and rejects unsafe input before touching the transport', async () => {
    const transport = mockTransport((cmd) => {
      expect(cmd).toBe(`realpath -e '/work/proj'`);
      return { stdout: '/work/proj\n', stderr: '', code: 0 };
    });
    const resolver = new RemotePathResolver(transport);
    expect(await resolver.resolveRealPath('/work/proj')).toBe('/work/proj');
  });

  it('rejects unsafe path input without calling the transport', async () => {
    const transport = mockTransport(() => ({ stdout: '', stderr: '', code: 0 }));
    const resolver = new RemotePathResolver(transport);
    await expect(resolver.resolveRealPath('/tmp; rm -rf /')).rejects.toThrow('Unsafe targetPath');
    expect(transport.exec).not.toHaveBeenCalled();
  });

  it('rejects when realpath exits non-zero (target does not exist)', async () => {
    const transport = mockTransport(() => ({ stdout: '', stderr: 'realpath: /work/missing: No such file or directory', code: 1 }));
    const resolver = new RemotePathResolver(transport);
    await expect(resolver.resolveRealPath('/work/missing')).rejects.toThrow('realpath failed');
  });

  it('expands a `~/...` path against $HOME instead of single-quoting it literally (regression: `realpath -e \'~/x\'` never expands under POSIX shells)', async () => {
    const transport = mockTransport((cmd) => {
      expect(cmd).toBe(`realpath -e "$HOME"'/workspace/repo'`);
      return { stdout: '/home/user/workspace/repo\n', stderr: '', code: 0 };
    });
    const resolver = new RemotePathResolver(transport);
    expect(await resolver.resolveRealPath('~/workspace/repo')).toBe('/home/user/workspace/repo');
  });

  it('expands a bare `~` against $HOME', async () => {
    const transport = mockTransport((cmd) => {
      expect(cmd).toBe(`realpath -e "$HOME"`);
      return { stdout: '/home/user\n', stderr: '', code: 0 };
    });
    const resolver = new RemotePathResolver(transport);
    expect(await resolver.resolveRealPath('~')).toBe('/home/user');
  });
});

describe('PathResolverFactory', () => {
  it('returns a LocalPathResolver for local servers', () => {
    const factory = new PathResolverFactory();
    expect(factory.create('local')).toBeInstanceOf(LocalPathResolver);
  });

  it('returns a RemotePathResolver for non-local servers given a transport', () => {
    const factory = new PathResolverFactory();
    const transport = mockTransport(() => ({ stdout: '', stderr: '', code: 0 }));
    expect(factory.create('agent', transport)).toBeInstanceOf(RemotePathResolver);
  });

  it('throws for non-local servers without a transport', () => {
    const factory = new PathResolverFactory();
    expect(() => factory.create('agent')).toThrow('Transport required');
  });
});

describe('assertPathContained', () => {
  it('resolves and passes when the target is within the allowed root', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-root-'));
    const target = path.join(root, 'sub');
    mkdirSync(target);
    try {
      // Must return the resolved real path (not undefined) — callers rely on
      // this to close the TOCTOU window between verifying and using a path
      // (Issue #27 review finding 2).
      const resolvedTarget = await new LocalPathResolver().resolveRealPath(target);
      await expect(assertPathContained(new LocalPathResolver(), target, root, 'test path')).resolves.toBe(resolvedTarget);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects when the target escapes the root via ..', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-root-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-outside-'));
    try {
      const escaped = path.join(root, '..', path.basename(outside));
      await expect(assertPathContained(new LocalPathResolver(), escaped, root, 'test path'))
        .rejects.toThrow(/escapes the allowed directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects when a symlink inside the root points outside it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-root-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-outside-'));
    const linkPath = path.join(root, 'escape-link');
    symlinkSync(outside, linkPath);
    try {
      await expect(assertPathContained(new LocalPathResolver(), linkPath, root, 'test path'))
        .rejects.toThrow(/escapes the allowed directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects (fails closed) when the target does not exist', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-root-'));
    try {
      await expect(assertPathContained(new LocalPathResolver(), path.join(root, 'nope'), root, 'test path'))
        .rejects.toThrow(/Cannot verify/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('assertDirectoryContained', () => {
  it('skips resolution/verification and returns candidateDir unchanged when allowedRoot is unset (no configured boundary)', async () => {
    const factory = new PathResolverFactory();
    await expect(
      assertDirectoryContained(factory, 'local', undefined, '/does/not/exist/at/all', null, 'test path'),
    ).resolves.toBe('/does/not/exist/at/all');
  });

  it('resolves via a local resolver and returns the resolved path when contained', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-root-'));
    const target = path.join(root, 'sub');
    mkdirSync(target);
    try {
      const factory = new PathResolverFactory();
      const resolvedTarget = await new LocalPathResolver().resolveRealPath(target);
      await expect(assertDirectoryContained(factory, 'local', undefined, target, root, 'test path'))
        .resolves.toBe(resolvedTarget);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects when the target escapes allowedRoot', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-root-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-outside-'));
    try {
      const factory = new PathResolverFactory();
      await expect(assertDirectoryContained(factory, 'local', undefined, outside, root, 'test path'))
        .rejects.toThrow(/escapes the allowed directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('routes through a remote resolver when serverType is not local', async () => {
    const factory = new PathResolverFactory();
    const calls: string[] = [];
    const transport = mockTransport((cmd) => {
      calls.push(cmd);
      if (cmd === `realpath -e '/work/proj/sub'`) return { stdout: '/work/proj/sub\n', stderr: '', code: 0 };
      if (cmd === `realpath -e '/work/proj'`) return { stdout: '/work/proj\n', stderr: '', code: 0 };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await expect(assertDirectoryContained(factory, 'agent', transport, '/work/proj/sub', '/work/proj', 'test path'))
      .resolves.toBe('/work/proj/sub');
    expect(calls).toContain(`realpath -e '/work/proj/sub'`);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  isPathContained,
  assertPathContained,
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
      await expect(assertPathContained(new LocalPathResolver(), target, root, 'test path')).resolves.toBeUndefined();
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

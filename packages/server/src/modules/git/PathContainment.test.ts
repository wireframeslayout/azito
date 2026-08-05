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
    expect(isPathContained({ target: '/a/b', allowedRoot: '/a/b' })).toBe(true);
  });

  it('accepts a path strictly beneath the root', () => {
    expect(isPathContained({ target: '/a/b/c', allowedRoot: '/a/b' })).toBe(true);
  });

  it('rejects a sibling path that merely shares a string prefix (regression: no prefix matching)', () => {
    expect(isPathContained({ target: '/a/bc', allowedRoot: '/a/b' })).toBe(false);
    expect(isPathContained({ target: '/a/bc/d', allowedRoot: '/a/b' })).toBe(false);
  });

  it('rejects a path that escapes the root via ..', () => {
    expect(isPathContained({ target: '/a/b/../../etc', allowedRoot: '/a/b' })).toBe(false);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isPathContained({ target: '/etc', allowedRoot: '/a/b' })).toBe(false);
  });

  it('accepts a legitimate child directory whose name happens to start with ".." (regression: bare rel.startsWith(\'..\') over-rejects)', () => {
    expect(isPathContained({ target: '/a/b/..cache', allowedRoot: '/a/b' })).toBe(true);
    expect(isPathContained({ target: '/a/b/..cache/nested', allowedRoot: '/a/b' })).toBe(true);
  });

  it('swapping target/allowedRoot flips the verdict (regression guard for Issue #27 review finding 4: adjacent same-typed args were mixed up during review and silently inverted containment). This is exactly the mistake the {target, allowedRoot} object shape exists to make visible at every call site — do not revert to positional string params.', () => {
    // A strict parent/child pair: contained one way, not contained the other.
    expect(isPathContained({ target: '/a/b/c', allowedRoot: '/a/b' })).toBe(true);
    expect(isPathContained({ target: '/a/b', allowedRoot: '/a/b/c' })).toBe(false);
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
      expect(cmd).toBe(`realpath -e -- '/work/proj'`);
      return { stdout: '/work/proj\n', stderr: '', code: 0 };
    });
    const resolver = new RemotePathResolver(transport);
    expect(await resolver.resolveRealPath('/work/proj')).toBe('/work/proj');
  });

  it('rejects an empty path without calling the transport', async () => {
    const transport = mockTransport(() => ({ stdout: '', stderr: '', code: 0 }));
    const resolver = new RemotePathResolver(transport);
    await expect(resolver.resolveRealPath('')).rejects.toThrow('must not be empty');
    expect(transport.exec).not.toHaveBeenCalled();
  });

  it('rejects a path containing a NUL byte without calling the transport', async () => {
    const transport = mockTransport(() => ({ stdout: '', stderr: '', code: 0 }));
    const resolver = new RemotePathResolver(transport);
    await expect(resolver.resolveRealPath('/work/\0proj')).rejects.toThrow('NUL byte');
    expect(transport.exec).not.toHaveBeenCalled();
  });

  it('does not reject a legitimate directory containing shell-sensitive characters (`+`, `,`, `=`, space) — the argument is single-quoted, not shell-parsed (Issue #27 review finding: over-broad SAFE_PATH_PATTERN rejected valid remote paths)', async () => {
    const dir = "/work/my project (v2), rel=1.0+build";
    const transport = mockTransport((cmd) => {
      expect(cmd).toBe(`realpath -e -- '${dir}'`);
      return { stdout: `${dir}\n`, stderr: '', code: 0 };
    });
    const resolver = new RemotePathResolver(transport);
    expect(await resolver.resolveRealPath(dir)).toBe(dir);
  });

  it('rejects when realpath exits non-zero (target does not exist)', async () => {
    const transport = mockTransport(() => ({ stdout: '', stderr: 'realpath: /work/missing: No such file or directory', code: 1 }));
    const resolver = new RemotePathResolver(transport);
    await expect(resolver.resolveRealPath('/work/missing')).rejects.toThrow('realpath failed');
  });

  it('expands a `~/...` path against $HOME instead of single-quoting it literally (regression: `realpath -e \'~/x\'` never expands under POSIX shells)', async () => {
    const transport = mockTransport((cmd) => {
      expect(cmd).toBe(`realpath -e -- "$HOME"'/workspace/repo'`);
      return { stdout: '/home/user/workspace/repo\n', stderr: '', code: 0 };
    });
    const resolver = new RemotePathResolver(transport);
    expect(await resolver.resolveRealPath('~/workspace/repo')).toBe('/home/user/workspace/repo');
  });

  it('expands a bare `~` against $HOME', async () => {
    const transport = mockTransport((cmd) => {
      expect(cmd).toBe(`realpath -e -- "$HOME"`);
      return { stdout: '/home/user\n', stderr: '', code: 0 };
    });
    const resolver = new RemotePathResolver(transport);
    expect(await resolver.resolveRealPath('~')).toBe('/home/user');
  });

  it('escapes a single quote in the path instead of letting it break out of the quoted shell word (Issue #27 critical: shell injection via a bare single-quote wrap in the old toRemotePathExpr — a path like `/work/x\'; touch /tmp/pwn; echo \'` used to execute arbitrary commands)', async () => {
    const evil = "/work/x'; touch /tmp/azito-pwn; echo '";
    const transport = mockTransport((cmd) => {
      // shellQuote() turns `'` into `'\''`, so the whole value stays a
      // single, inert shell word — no unquoted `;` reaches the shell.
      expect(cmd).toBe(`realpath -e -- '/work/x'\\''; touch /tmp/azito-pwn; echo '\\'''`);
      return { stdout: `${evil}\n`, stderr: '', code: 0 };
    });
    const resolver = new RemotePathResolver(transport);
    expect(await resolver.resolveRealPath(evil)).toBe(evil);
  });

  it('escapes a single quote in the `~/...` branch the same way (regression: the $HOME branch bypassed quoting entirely before the fix)', async () => {
    const evil = "~/proj'; touch /tmp/azito-pwn; echo '";
    const transport = mockTransport((cmd) => {
      expect(cmd).toBe(`realpath -e -- "$HOME"'/proj'\\''; touch /tmp/azito-pwn; echo '\\'''`);
      return { stdout: '/home/user/proj\n', stderr: '', code: 0 };
    });
    const resolver = new RemotePathResolver(transport);
    expect(await resolver.resolveRealPath(evil)).toBe('/home/user/proj');
  });

  it('passes a path starting with `-` after `--` so it cannot be parsed as a `realpath` option', async () => {
    const dashPath = '-rf /work/proj';
    const transport = mockTransport((cmd) => {
      expect(cmd).toBe(`realpath -e -- '${dashPath}'`);
      // `--` must precede the quoted argument for GNU coreutils to stop
      // option parsing before it.
      expect(cmd.indexOf('-- ')).toBeLessThan(cmd.indexOf(`'${dashPath}'`));
      return { stdout: `${dashPath}\n`, stderr: '', code: 0 };
    });
    const resolver = new RemotePathResolver(transport);
    expect(await resolver.resolveRealPath(dashPath)).toBe(dashPath);
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
      await expect(assertPathContained(new LocalPathResolver(), { target, allowedRoot: root }, 'test path')).resolves.toBe(resolvedTarget);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects when the target escapes the root via ..', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-root-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-outside-'));
    try {
      const escaped = path.join(root, '..', path.basename(outside));
      await expect(assertPathContained(new LocalPathResolver(), { target: escaped, allowedRoot: root }, 'test path'))
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
      await expect(assertPathContained(new LocalPathResolver(), { target: linkPath, allowedRoot: root }, 'test path'))
        .rejects.toThrow(/escapes the allowed directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects (fails closed) when the target does not exist', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-root-'));
    try {
      await expect(assertPathContained(new LocalPathResolver(), { target: path.join(root, 'nope'), allowedRoot: root }, 'test path'))
        .rejects.toThrow(/Cannot verify/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('swapping target/allowedRoot flips the verdict (same regression guard as isPathContained, at the resolver-driven layer): a directory strictly beneath another is contained one way and rejected the other. Confirms the object-argument fix propagates through assertPathContained, not just the pure isPathContained check.', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-root-'));
    const child = path.join(root, 'sub');
    mkdirSync(child);
    try {
      await expect(assertPathContained(new LocalPathResolver(), { target: child, allowedRoot: root }, 'test path'))
        .resolves.toBeTruthy();
      await expect(assertPathContained(new LocalPathResolver(), { target: root, allowedRoot: child }, 'test path'))
        .rejects.toThrow(/escapes the allowed directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects (fail closed) when the resolved target is contained but its resolved path is not in a safe path format, with an error distinguishable from a containment violation (Issue #27: a `\'`-containing directory name reached via a symlink under the allowed root used to defeat downstream unquoted shell interpolation in PushVerifier/RemoteWorktreeService)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-root-'));
    // The real (symlink-resolution-target) directory itself carries the
    // unsafe character — this is what `assertSafePath` must catch, since a
    // symlink alone (with a safe name) would already be handled by ordinary
    // containment resolution.
    const unsafeReal = path.join(root, "it's-a-dir; echo $HOME");
    mkdirSync(unsafeReal);
    const link = path.join(root, 'safe-looking-link');
    symlinkSync(unsafeReal, link);
    try {
      const err = await assertPathContained(new LocalPathResolver(), { target: link, allowedRoot: root }, 'test path').catch(
        (e) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/not in a safe path format/);
      expect((err as Error).message).not.toMatch(/escapes the allowed directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a resolved path containing a space even without any other unsafe character', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-root-'));
    const unsafeReal = path.join(root, 'has a space');
    mkdirSync(unsafeReal);
    try {
      await expect(assertPathContained(new LocalPathResolver(), { target: unsafeReal, allowedRoot: root }, 'test path'))
        .rejects.toThrow(/not in a safe path format/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still accepts an ordinary safe resolved path (regression guard against over-rejecting the common case)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-root-'));
    const target = path.join(root, 'normal-sub.dir_1');
    mkdirSync(target);
    try {
      const resolvedTarget = await new LocalPathResolver().resolveRealPath(target);
      await expect(assertPathContained(new LocalPathResolver(), { target, allowedRoot: root }, 'test path')).resolves.toBe(resolvedTarget);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('assertDirectoryContained', () => {
  it('skips resolution/verification and returns candidateDir unchanged when allowedRoot is unset (no configured boundary)', async () => {
    const factory = new PathResolverFactory();
    await expect(
      assertDirectoryContained(factory, 'local', undefined, { target: '/does/not/exist/at/all', allowedRoot: null }, 'test path'),
    ).resolves.toBe('/does/not/exist/at/all');
  });

  it('resolves via a local resolver and returns the resolved path when contained', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-root-'));
    const target = path.join(root, 'sub');
    mkdirSync(target);
    try {
      const factory = new PathResolverFactory();
      const resolvedTarget = await new LocalPathResolver().resolveRealPath(target);
      await expect(assertDirectoryContained(factory, 'local', undefined, { target, allowedRoot: root }, 'test path'))
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
      await expect(assertDirectoryContained(factory, 'local', undefined, { target: outside, allowedRoot: root }, 'test path'))
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
      if (cmd === `realpath -e -- '/work/proj/sub'`) return { stdout: '/work/proj/sub\n', stderr: '', code: 0 };
      if (cmd === `realpath -e -- '/work/proj'`) return { stdout: '/work/proj\n', stderr: '', code: 0 };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await expect(assertDirectoryContained(factory, 'agent', transport, { target: '/work/proj/sub', allowedRoot: '/work/proj' }, 'test path'))
      .resolves.toBe('/work/proj/sub');
    expect(calls).toContain(`realpath -e -- '/work/proj/sub'`);
  });

  it('swapping target/allowedRoot flips the verdict at the assertDirectoryContained entry point too (same regression guard as isPathContained/assertPathContained above) — confirms the fix holds through the full wrapper chain every real caller (ExecuteTaskUseCase, TaskRestoreService, WindowRespawnService) goes through.', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'azito-path-containment-root-'));
    const child = path.join(root, 'sub');
    mkdirSync(child);
    try {
      const factory = new PathResolverFactory();
      await expect(assertDirectoryContained(factory, 'local', undefined, { target: child, allowedRoot: root }, 'test path'))
        .resolves.toBeTruthy();
      await expect(assertDirectoryContained(factory, 'local', undefined, { target: root, allowedRoot: child }, 'test path'))
        .rejects.toThrow(/escapes the allowed directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileBrowseService, FileBrowseError } from './FileBrowseService';
import type { ServerConfig } from '../servers/Server';
import { shellQuote as sq } from '../../shared/shellQuote';

function createLocalServer(dir: string): ServerConfig {
  return {
    name: 'test-local',
    type: 'local',
    directory: dir,
  } as unknown as ServerConfig;
}

// Minimal mock of TmuxClient for testing shell command construction
function createMockTmux(responses?: Record<string, string>) {
  const commands: string[] = [];
  return {
    commands,
    execCommand: async (_srv: unknown, cmd: string) => {
      commands.push(cmd);
      if (responses) {
        for (const [pattern, stdout] of Object.entries(responses)) {
          if (cmd.includes(pattern)) return { stdout, stderr: '', code: 0 };
        }
      }
      return { stdout: '100', stderr: '', code: 0 };
    },
  };
}

describe('FileBrowseService shell quoting', () => {
  it('quotes filePath with single quotes in remote stat commands', async () => {
    const mock = createMockTmux();
    const svc = new FileBrowseService(mock as any);
    const srv = { type: 'agent', name: 'test', host: 'user@host' };

    try {
      await svc.getFileContent(srv as any, '/tmp/test$(id).txt');
    } catch {}

    const statCmd = mock.commands[0];
    expect(statCmd).toContain("'/tmp/test$(id).txt'");
    expect(statCmd).not.toContain('"');
  });

  it('escapes single quotes in filePath for remote commands', async () => {
    const mock = createMockTmux();
    const svc = new FileBrowseService(mock as any);
    const srv = { type: 'agent', name: 'test', host: 'user@host' };

    try {
      await svc.getFileContent(srv as any, "/tmp/test'file.txt");
    } catch {}

    const statCmd = mock.commands[0];
    expect(statCmd).toContain("'/tmp/test'\\''file.txt'");
  });

  it('rejects non-regular files on local server', async () => {
    const svc = new FileBrowseService({} as any);
    const srv = { type: 'local', name: 'local' };

    await expect(
      svc.getFileContent(srv as any, '/dev/zero'),
    ).rejects.toThrow('Not a regular file');
  });

  it('uses -- separator in the remote base64 read command', async () => {
    const mock = createMockTmux({ 'test -f': 'ok' });
    const svc = new FileBrowseService(mock as any);
    const srv = { type: 'agent', name: 'test', host: 'user@host' };

    try {
      await svc.getFileContent(srv as any, '/tmp/normal.txt');
    } catch {}

    const base64Cmd = mock.commands.find(c => c.startsWith('base64'));
    expect(base64Cmd).toBeDefined();
    expect(base64Cmd).toContain('base64 -w0 --');
    expect(base64Cmd).toContain('base64 --');
  });

  // Issue #27 review Critical 1: the mtime lookup at the end of the remote
  // getFileContent() path used to interpolate filePath inside bare double
  // quotes (`stat -c%Y "${filePath}"`), which lets a path containing
  // `$(...)` execute as a subshell. Drives a full success path (typeCheck ->
  // sizeResult -> base64 read -> mtime) so the mtime command itself is inspected,
  // not just the first (already-quoted) typeCheck command the two tests
  // above cover.
  it('quotes filePath in the mtime lookup command, not raw double-quote interpolation', async () => {
    const commands: string[] = [];
    const injectionPath = '/tmp/test$(touch /tmp/pwned).txt';
    const mock = {
      commands,
      execCommand: async (_srv: unknown, cmd: string) => {
        commands.push(cmd);
        if (cmd.startsWith('test -f')) return { stdout: 'ok\n', stderr: '', code: 0 };
        if (cmd.startsWith('stat -c%s') || cmd.includes('stat -f%z')) return { stdout: '5\n', stderr: '', code: 0 };
        if (cmd.startsWith('base64')) return { stdout: Buffer.from('hello', 'utf-8').toString('base64'), stderr: '', code: 0 };
        // mtime lookup (stat -c%.Y / -c%Y / -f%m chain)
        return { stdout: '1750000000\n', stderr: '', code: 0 };
      },
    };
    const svc = new FileBrowseService(mock as any);
    const srv = { type: 'agent', name: 'test', host: 'user@host' };

    const result = await svc.getFileContent(srv as any, injectionPath);
    expect('mtime' in result && result.mtime).toBe(1750000000 * 1000);

    const mtimeCmd = commands[commands.length - 1];
    expect(mtimeCmd).toContain("'" + injectionPath.replace(/'/g, "'\\''") + "'");
    // The raw path must never appear inside a bare double-quoted segment —
    // that is exactly the shape ("${filePath}") that let $(...) expand.
    expect(mtimeCmd).not.toContain(`"${injectionPath}"`);
    expect(mtimeCmd).not.toContain('"');
  });
});

// Review Important 1 (remote read): the old `cat -- <file>` read went through the persistent SSH
// shell's marker-delimited output pipeline (SshClient.drainBuffer), which strips exactly one leading
// and one trailing newline from every command's stdout to remove the shell's own newlines around the
// `\x02AGENTMGR_B/E` markers. For `cat` output that boundary trim is indistinguishable from "the
// file's own trailing newline" — a normal text file ending in `\n` had it silently stripped, so the
// hash the client fetched (from the newline-stripped content) could never match the real on-disk bytes
// `sha256sum` sees at save time, and every such save 409'd (or, with `force`, truncated the newline for
// real). These tests model that same boundary-stripping behavior on the mocked stdout to prove the
// base64-based read is immune to it: base64's alphabet contains no `\r`/`\n`, so a boundary trim can
// only ever eat wrapping whitespace `base64` itself added, never a content byte.
describe('FileBrowseService.getFileContent (remote) — lossless base64 read', () => {
  // Mirrors SshClient.drainBuffer's exact boundary-trim (see SshClient.ts): strip one leading
  // `\r?\n`, one trailing `\r?\n` or `\r`, then normalize any remaining `\r\n` to `\n`.
  function simulateSshBoundaryTrim(output: string): string {
    return output.replace(/^\r?\n/, '').replace(/\r?\n$/, '').replace(/\r$/, '').replace(/\r\n/g, '\n');
  }

  it('reads a file ending in a newline and produces a hash matching the exact original bytes', async () => {
    const originalContent = 'line one\nline two\n'; // trailing newline — the corruption-prone case
    const b64 = Buffer.from(originalContent, 'utf-8').toString('base64');
    const expectedHash = createHash('sha256').update(originalContent, 'utf-8').digest('hex');

    const mock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        if (cmd.startsWith('test -f')) return { stdout: 'ok\n', stderr: '', code: 0 };
        if (cmd.startsWith('stat -c%s') || cmd.includes('stat -f%z')) {
          return { stdout: `${Buffer.byteLength(originalContent, 'utf-8')}\n`, stderr: '', code: 0 };
        }
        if (cmd.startsWith('base64')) {
          // Simulate the persistent-shell boundary trim landing on the base64 payload, exactly as it
          // would on real stdout — base64 has no \r/\n of its own here (single line, no wrapping), so
          // trimming a "leading/trailing newline" has nothing to remove and the payload survives intact.
          return { stdout: simulateSshBoundaryTrim(b64), stderr: '', code: 0 };
        }
        // mtime lookup
        return { stdout: '1750000000\n', stderr: '', code: 0 };
      },
    };
    const svc = new FileBrowseService(mock as any);
    const srv = { type: 'agent', name: 'test', host: 'user@host' };

    const result = await svc.getFileContent(srv as any, '/tmp/trailing-newline.txt');
    expect('content' in result).toBe(true);
    if ('content' in result) {
      expect(result.content).toBe(originalContent);
      expect(result.hash).toBe(expectedHash);
    }
  });

  it('recovers the exact bytes even when the shell boundary-trim eats a synthetic wrap newline', async () => {
    // Simulate a non-GNU `base64` build that wraps output at 76 chars (the `-w0` fallback branch),
    // where the SSH shell's boundary trim removes a leading/trailing newline that is pure formatting,
    // not file content. Whitespace-stripping the whole payload in Node must still recover byte-exact
    // content regardless of exactly where that formatting newline landed.
    const originalContent = 'x'.repeat(120) + '\n';
    const rawB64 = Buffer.from(originalContent, 'utf-8').toString('base64');
    const wrapped = rawB64.replace(/(.{76})/g, '$1\n'); // simulate non -w0 base64 wrapping
    const expectedHash = createHash('sha256').update(originalContent, 'utf-8').digest('hex');

    const mock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        if (cmd.startsWith('test -f')) return { stdout: 'ok\n', stderr: '', code: 0 };
        if (cmd.startsWith('stat -c%s') || cmd.includes('stat -f%z')) {
          return { stdout: `${Buffer.byteLength(originalContent, 'utf-8')}\n`, stderr: '', code: 0 };
        }
        if (cmd.startsWith('base64')) {
          return { stdout: simulateSshBoundaryTrim(wrapped), stderr: '', code: 0 };
        }
        return { stdout: '1750000000\n', stderr: '', code: 0 };
      },
    };
    const svc = new FileBrowseService(mock as any);
    const srv = { type: 'agent', name: 'test', host: 'user@host' };

    const result = await svc.getFileContent(srv as any, '/tmp/wrapped.txt');
    expect('content' in result).toBe(true);
    if ('content' in result) {
      expect(result.content).toBe(originalContent);
      expect(result.hash).toBe(expectedHash);
    }
  });
});

describe('FileBrowseService.writeFileContent', () => {
  let tmpDir: string;
  let service: FileBrowseService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-test-'));
    service = new FileBrowseService({} as any);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes file and returns mtime', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'original');
    const srv = createLocalServer(tmpDir);
    const result = await service.writeFileContent(srv, filePath, 'updated');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('updated');
    expect(result.mtime).toBeGreaterThan(0);
  });

  it('rejects content exceeding MAX_FILE_SIZE', async () => {
    const filePath = path.join(tmpDir, 'large.txt');
    fs.writeFileSync(filePath, 'x');
    const srv = createLocalServer(tmpDir);
    const bigContent = 'x'.repeat(501 * 1024);
    await expect(service.writeFileContent(srv, filePath, bigContent))
      .rejects.toThrow(FileBrowseError);
  });

  it('returns 409 on mtime conflict', async () => {
    const filePath = path.join(tmpDir, 'conflict.txt');
    fs.writeFileSync(filePath, 'original');
    const srv = createLocalServer(tmpDir);
    const staleTime = Date.now() - 60000;
    try {
      await service.writeFileContent(srv, filePath, 'new content', staleTime);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FileBrowseError);
      expect((err as FileBrowseError).status).toBe(409);
    }
  });

  it('writes successfully when mtime matches', async () => {
    const filePath = path.join(tmpDir, 'match.txt');
    fs.writeFileSync(filePath, 'original');
    const stat = fs.statSync(filePath);
    const srv = createLocalServer(tmpDir);
    const result = await service.writeFileContent(srv, filePath, 'new content', stat.mtimeMs);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
    expect(result.mtime).toBeGreaterThanOrEqual(stat.mtimeMs);
  });

  // Issue #27 review Important 3: `Math.abs(stat.mtimeMs - baseMtime) > 1000`
  // let an external edit that landed within the same second slip through
  // silently. baseMtime round-trips the exact mtimeMs this service returned
  // earlier, so the comparison can (and now does) be an exact equality.
  it('rejects a conflicting edit that landed within the same second (millisecond precision)', async () => {
    const filePath = path.join(tmpDir, 'same-second.txt');
    fs.writeFileSync(filePath, 'original');
    // Pin both mtimes to the same wall-clock second, 800ms apart, so the old
    // `Math.abs(...) > 1000` tolerance would have let this race through as
    // "no conflict" — deterministic via utimesSync rather than relying on
    // two real writeFileSync calls happening to land in different ticks.
    const baseDate = new Date(2026, 0, 1, 12, 0, 0, 100);
    fs.utimesSync(filePath, baseDate, baseDate);
    const staleBaseMtime = fs.statSync(filePath).mtimeMs;

    fs.writeFileSync(filePath, 'raced edit');
    const racedDate = new Date(2026, 0, 1, 12, 0, 0, 900);
    fs.utimesSync(filePath, racedDate, racedDate);

    const srv = createLocalServer(tmpDir);
    await expect(
      service.writeFileContent(srv, filePath, 'my edit', staleBaseMtime),
    ).rejects.toMatchObject({ status: 409 });
  });

  // Issue #27 review Important 3: content-hash optimistic lock. On environments with only
  // second-precision mtime the mtime check alone cannot detect an external edit that landed within
  // the same second; a sha256 comparison of the actual bytes catches it regardless of timing.
  it('returns 409 on hash conflict even when mtime matches', async () => {
    const filePath = path.join(tmpDir, 'hash-conflict.txt');
    fs.writeFileSync(filePath, 'original');
    const stat = fs.statSync(filePath);
    const srv = createLocalServer(tmpDir);
    const staleHash = createHash('sha256').update('stale content the reader actually saw', 'utf-8').digest('hex');
    await expect(
      service.writeFileContent(srv, filePath, 'my edit', stat.mtimeMs, staleHash),
    ).rejects.toMatchObject({ status: 409 });
    // Must not have been overwritten.
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('original');
  });

  it('writes successfully when the content hash matches', async () => {
    const filePath = path.join(tmpDir, 'hash-match.txt');
    fs.writeFileSync(filePath, 'original');
    const srv = createLocalServer(tmpDir);
    const currentHash = createHash('sha256').update('original', 'utf-8').digest('hex');
    const result = await service.writeFileContent(srv, filePath, 'new content', undefined, currentHash);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
    expect(result.hash).toBe(createHash('sha256').update('new content', 'utf-8').digest('hex'));
  });

  it('force bypasses both the mtime and hash conflict checks', async () => {
    const filePath = path.join(tmpDir, 'force.txt');
    fs.writeFileSync(filePath, 'original');
    const srv = createLocalServer(tmpDir);
    // Stale on both counts, but writeFileContent is called the way routes.ts calls it under
    // `force: true` — baseMtime/baseHash simply omitted rather than passed-and-ignored.
    const result = await service.writeFileContent(srv, filePath, 'forced edit');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('forced edit');
    expect(result.hash).toBe(createHash('sha256').update('forced edit', 'utf-8').digest('hex'));
  });

  // Issue #27 review Critical 2 (local half): writeFileContent opens with
  // O_NOFOLLOW so a symlink swapped in at the save target between the
  // route's containment check and this write cannot redirect the write to
  // wherever the symlink points.
  it('refuses to write through a symlink (O_NOFOLLOW)', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'original outside content');
    const linkPath = path.join(tmpDir, 'escape-link.txt');
    fs.symlinkSync(outsideFile, linkPath);
    const srv = createLocalServer(tmpDir);

    await expect(
      service.writeFileContent(srv, linkPath, 'attacker-controlled content'),
    ).rejects.toMatchObject({ status: 400 });
    // The symlink target must be untouched.
    expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('original outside content');

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe('FileBrowseService.resolveExistingTargetRealPath', () => {
  let tmpDir: string;
  const svc = new FileBrowseService({} as any);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Issue #27 review Critical 2: the containment check the PUT route runs on
  // the parent directory alone can't see that the save target itself is a
  // symlink pointing outside workingDirectory. This resolves the target's
  // real path so the route can re-verify containment on it (see
  // PathContainment.isPathContained usage in routes.ts).
  it('resolves a symlinked target to its real (outside) path', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret');
    const linkPath = path.join(tmpDir, 'link.txt');
    fs.symlinkSync(outsideFile, linkPath);
    const srv = { type: 'local', name: 'local' } as any;

    const resolved = await svc.resolveExistingTargetRealPath(srv, linkPath);
    expect(resolved).toBe(fs.realpathSync(outsideFile));

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('returns null when the target does not exist yet', async () => {
    const srv = { type: 'local', name: 'local' } as any;
    const resolved = await svc.resolveExistingTargetRealPath(srv, path.join(tmpDir, 'nope.txt'));
    expect(resolved).toBeNull();
  });
});

describe('FileBrowseService.writeFileContent (remote)', () => {
  it('splits base64 into chunks so every exec command stays under MAX_ARG_STRLEN', async () => {
    const MAX_ARG_STRLEN = 131072;
    const commands: string[] = [];
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        commands.push(cmd);
        // デコード+置換コマンドは成功マーカーを返す（Issue #27 review Important 1）
        if (cmd.includes('base64 -d <') && cmd.includes('AZITO_WRITE_OK')) {
          return { stdout: 'AZITO_WRITE_OK\n', stderr: '', code: 0 };
        }
        // 書き込み後の stat 検証には epoch 秒を返す（%.Y が最初に試される）
        if (cmd.startsWith('stat ')) return { stdout: '1750000000\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const service = new FileBrowseService(tmuxMock as any);
    const srv = { name: 'remote', type: 'ssh' } as any;

    const content = 'x'.repeat(300 * 1024); // 300KB → base64 400KB
    const result = await service.writeFileContent(srv, '/tmp/big.txt', content);

    expect(result.mtime).toBe(1750000000 * 1000);
    for (const cmd of commands) {
      expect(cmd.length).toBeLessThan(MAX_ARG_STRLEN);
    }
    const chunkCmds = commands.filter((c) => c.startsWith("printf '%s' "));
    expect(chunkCmds.length).toBeGreaterThan(1);
    // チャンクを連結すると元の base64 と一致する
    const joined = chunkCmds
      .map((c) => c.slice("printf '%s' '".length, c.indexOf("' >> ")))
      .join('');
    expect(joined).toBe(Buffer.from(content, 'utf-8').toString('base64'));
    // 最後にデコード + mv + 成功マーカー + 一時ファイル削除コマンドが実行される
    expect(commands.some((c) => c.includes('base64 -d <') && c.includes('mv -f') && c.includes('AZITO_WRITE_OK') && c.includes('rm -f'))).toBe(true);
    // 一時ファイル名にはリクエストごとの乱数サフィックスが入り、固定名を使わない
    // （並行保存で互いの一時ファイルを踏みつけないため。Issue #27 review Important 2）
    expect(commands.some((c) => /\.azito-upload-[0-9a-f]{16}/.test(c))).toBe(true);
  });

  // Issue #27 review Important 1: the decode command's result used to be
  // ignored entirely — a failed `base64 -d` could leave the destination
  // untouched, and the immediately-following stat would still report the
  // *old* file's mtime as a success. SSH transports always return exit code
  // 0 (RemoteWorktreeService.hasGitError's documented reason for using a
  // stdout marker instead), so this asserts the write is judged by the
  // explicit `AZITO_WRITE_OK` marker in stdout, not by exit code or by the
  // later stat call succeeding.
  it('throws when the remote write command reports no success marker', async () => {
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        // The decode/mv step "fails" silently (as a real base64/mv error
        // would under `code: 0` from an SSH transport) — no marker in stdout.
        if (cmd.includes('base64 -d <')) return { stdout: '', stderr: 'base64: invalid input\n', code: 0 };
        // The post-write stat would still report the pre-existing file's
        // mtime as if nothing had gone wrong — this must not be reached as
        // a source of truth for success.
        if (cmd.startsWith('stat ')) return { stdout: '1750000000\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const service = new FileBrowseService(tmuxMock as any);
    const srv = { name: 'remote', type: 'ssh' } as any;

    await expect(
      service.writeFileContent(srv, '/tmp/quiet-failure.txt', 'content'),
    ).rejects.toMatchObject({ status: 500 });
  });

  // Review Important 2 (remote half): a transient `stat` failure or the file
  // disappearing must not be read as "no conflict" — the old code only
  // compared mtimes `if (current != null && ...)`, so a null `current` (stat
  // returned nothing) skipped the check entirely and wrote unconditionally.
  it('fails closed with 409 when the remote mtime cannot be fetched but baseMtime was supplied', async () => {
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        // Every stat variant (mtime chain and mode chain) returns nothing,
        // simulating a transient stat failure / vanished file.
        if (cmd.startsWith('stat')) return { stdout: '', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const service = new FileBrowseService(tmuxMock as any);
    const srv = { name: 'remote', type: 'ssh' } as any;

    await expect(
      service.writeFileContent(srv, '/tmp/vanished.txt', 'content', Date.now()),
    ).rejects.toMatchObject({ status: 409 });
  });

  // Review followup (macOS/BSD remote hosts): GNU coreutils `base64` decodes with `-d`, but BSD/macOS
  // `base64` has no `-d` flag at all — it uses `-D` — so a save against a macOS remote host previously
  // failed outright (or, if $qDecoded happened to already exist, could replace the target with empty
  // content) once the decode step's own success marker was verified (Issue #27 review Important 1).
  // The write command must retry with `base64 -D` when `-d` fails, after truncating the decode
  // destination back to empty so the retry doesn't build on a partial `-d` attempt.
  it('falls back to base64 -D when base64 -d fails (BSD/macOS remote)', async () => {
    const commands: string[] = [];
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        commands.push(cmd);
        if (cmd.includes('base64 -d <')) return { stdout: 'AZITO_WRITE_OK\n', stderr: '', code: 0 };
        if (cmd.startsWith('stat ')) return { stdout: '1750000000\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const service = new FileBrowseService(tmuxMock as any);
    const srv = { name: 'remote-macos', type: 'ssh' } as any;

    await service.writeFileContent(srv, '/tmp/macos-target.txt', 'content');

    const writeCmd = commands.find((c) => c.includes('base64 -d <') && c.includes('mv -f'));
    expect(writeCmd).toBeDefined();
    // The -d attempt is tried first, silenced, then the -D fallback runs against a truncated decode
    // destination if -d failed.
    expect(writeCmd).toMatch(/base64 -d < .+? > .+? 2>\/dev\/null \|\| \{ : > .+?; base64 -D < .+? > .+?; \}/);
  });

  // Review Important 3: replacing an existing remote file via decode-to-tempfile
  // + `mv -f` used to drop the original file's permission bits (e.g. 0755 ->
  // the tempfile's default 0644 from the shell redirection). The write command
  // must chmod the tempfile to the existing target's mode before the mv.
  it('preserves the existing remote file mode across the mv replace', async () => {
    const commands: string[] = [];
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        commands.push(cmd);
        if (cmd.includes('base64 -d <')) return { stdout: 'AZITO_WRITE_OK\n', stderr: '', code: 0 };
        if (cmd.startsWith('stat -c%a')) return { stdout: '755\n', stderr: '', code: 0 };
        if (cmd.startsWith('stat ')) return { stdout: '1750000000\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const service = new FileBrowseService(tmuxMock as any);
    const srv = { name: 'remote', type: 'ssh' } as any;

    await service.writeFileContent(srv, '/tmp/executable.sh', '#!/bin/sh\necho hi\n');

    const writeCmd = commands.find((c) => c.includes('base64 -d <') && c.includes('mv -f'));
    expect(writeCmd).toBeDefined();
    expect(writeCmd).toContain("chmod '755'");
    // chmod must run on the decoded tempfile before the mv, not after
    expect(writeCmd!.indexOf('chmod')).toBeLessThan(writeCmd!.indexOf('mv -f'));
  });

  it('does not attempt chmod when the file is newly created (no existing mode)', async () => {
    const commands: string[] = [];
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        commands.push(cmd);
        if (cmd.includes('base64 -d <')) return { stdout: 'AZITO_WRITE_OK\n', stderr: '', code: 0 };
        if (cmd.startsWith('stat -c%a')) return { stdout: '', stderr: '', code: 0 };
        if (cmd.startsWith('stat ')) return { stdout: '1750000000\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const service = new FileBrowseService(tmuxMock as any);
    const srv = { name: 'remote', type: 'ssh' } as any;

    await service.writeFileContent(srv, '/tmp/new-file.txt', 'content');

    const writeCmd = commands.find((c) => c.includes('base64 -d <') && c.includes('mv -f'));
    expect(writeCmd).toBeDefined();
    expect(writeCmd).not.toContain('chmod');
  });

  // Issue #27 review Important 3 (remote content-hash lock): on hosts whose `stat` only reports
  // whole-second mtime, a baseHash mismatch must still be caught via sha256sum/shasum even when the
  // mtime check would pass (same-second race).
  it('returns 409 on remote hash conflict, without performing the write', async () => {
    const commands: string[] = [];
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        commands.push(cmd);
        if (cmd.startsWith('sha256sum') || cmd.includes('shasum -a 256')) {
          return { stdout: `${'a'.repeat(64)}  /tmp/hash-conflict.txt\n`, stderr: '', code: 0 };
        }
        if (cmd.startsWith('stat ')) return { stdout: '1750000000\n', stderr: '', code: 0 };
        // A real base64 -d / mv should never be reached — fail loudly if it is.
        if (cmd.includes('base64 -d <')) return { stdout: 'AZITO_WRITE_OK\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const service = new FileBrowseService(tmuxMock as any);
    const srv = { name: 'remote', type: 'ssh' } as any;
    const staleHash = 'b'.repeat(64); // does not match the 'a'.repeat(64) the mock reports as current

    await expect(
      service.writeFileContent(srv, '/tmp/hash-conflict.txt', 'new content', undefined, staleHash),
    ).rejects.toMatchObject({ status: 409 });
    expect(commands.some((c) => c.includes('base64 -d <') && c.includes('mv -f'))).toBe(false);
  });

  it('writes successfully when the remote content hash matches', async () => {
    const currentHash = createHash('sha256').update('original', 'utf-8').digest('hex');
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        if (cmd.startsWith('sha256sum') || cmd.includes('shasum -a 256')) {
          return { stdout: `${currentHash}  /tmp/hash-match.txt\n`, stderr: '', code: 0 };
        }
        if (cmd.includes('base64 -d <')) return { stdout: 'AZITO_WRITE_OK\n', stderr: '', code: 0 };
        if (cmd.startsWith('stat ')) return { stdout: '1750000000\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const service = new FileBrowseService(tmuxMock as any);
    const srv = { name: 'remote', type: 'ssh' } as any;

    const result = await service.writeFileContent(srv, '/tmp/hash-match.txt', 'new content', undefined, currentHash);
    expect(result.hash).toBe(createHash('sha256').update('new content', 'utf-8').digest('hex'));
  });

  // Issue #27 review Important 3: when neither sha256sum nor shasum is available on the remote host,
  // hash verification must be treated as "unavailable", not "matches" — the save proceeds on the
  // (already-run) mtime check alone rather than either blocking every save on that host or silently
  // skipping conflict detection with a false "verified" signal.
  it('falls back to mtime-only conflict detection when no remote hash tool is available', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        // Both sha256sum and shasum fail/are absent — empty stdout, as `2>/dev/null || ...` yields
        // when neither tool exists.
        if (cmd.startsWith('sha256sum') || cmd.includes('shasum -a 256')) {
          return { stdout: '', stderr: '', code: 0 };
        }
        if (cmd.includes('base64 -d <')) return { stdout: 'AZITO_WRITE_OK\n', stderr: '', code: 0 };
        if (cmd.startsWith('stat ')) return { stdout: '1750000000\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const service = new FileBrowseService(tmuxMock as any);
    const srv = { name: 'remote', type: 'ssh' } as any;

    const result = await service.writeFileContent(srv, '/tmp/no-hash-tool.txt', 'new content', undefined, 'c'.repeat(64));
    expect(result.mtime).toBe(1750000000 * 1000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sha256sum/shasum unavailable'));
    warnSpy.mockRestore();
  });

  // Critical fix (nested single-quote breakage in the trap): the trap command must be built by
  // shellQuote()-ing the fully-assembled `rm -f <upload> <decoded>` string as one unit, not by
  // interpolating already-quoted (single-quoted) upload/decoded tokens inside a hand-written outer
  // single-quoted literal — POSIX single quotes do not nest, so the outer quote would close at the
  // first `'` inside a path, letting trailing bytes of a containment-passing path (e.g. containing
  // `;`, `'`, or `#`) execute as shell syntax when the trap fires.
  it('quotes the trap cleanup command as a single unit even when the path contains shell metacharacters', async () => {
    const commands: string[] = [];
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        commands.push(cmd);
        if (cmd.includes('base64 -d <')) return { stdout: 'AZITO_WRITE_OK\n', stderr: '', code: 0 };
        if (cmd.startsWith('stat ')) return { stdout: '1750000000\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const service = new FileBrowseService(tmuxMock as any);
    const srv = { name: 'remote', type: 'ssh' } as any;
    // A path with a single quote, a semicolon, a space and a `#` — all legal path bytes on POSIX,
    // and none of them rejected by containment validation (which only cares about `..`/symlink escape,
    // not shell metacharacters — the shell-safety burden falls entirely on shellQuote()).
    const trickyPath = "/tmp/it's a; dangerous #path/file.txt";

    await service.writeFileContent(srv, trickyPath, 'content');

    const writeCmd = commands.find((c) => c.includes('base64 -d <') && c.includes('mv -f'));
    expect(writeCmd).toBeDefined();

    // Recover the exact (already shellQuote()-wrapped) upload/decoded tokens the command used for the
    // `wc -c` / `base64 -d` steps, then assert the trap argument is exactly `sq(cleanup)` built from
    // those same tokens — i.e. the cleanup string is quoted as one unit, not assembled by nesting two
    // pre-quoted tokens inside a hand-written outer pair of single quotes.
    const uploadToken = writeCmd!.match(/wc -c < (.+?) \| tr -d/)?.[1];
    const decodedToken = writeCmd!.match(/base64 -d < .+? > (.+?) 2>\/dev\/null/)?.[1];
    expect(uploadToken).toBeDefined();
    expect(decodedToken).toBeDefined();
    const expectedCleanup = `rm -f ${uploadToken} ${decodedToken}`;
    expect(writeCmd).toContain(`trap ${sq(expectedCleanup)} EXIT`);

    // Guard against the specific regression: the buggy version produced
    // `trap 'rm -f '\''...it'\''s a...'\'' '\''...'\''' EXIT` where an *unescaped* `'` from the tricky
    // path terminates the trap's quoting early, right after `it`. That unescaped-quote-followed-by-plain-text
    // pattern must not appear.
    expect(writeCmd).not.toMatch(/trap 'rm -f '\\''\/tmp\/it' /);
  });

  // Review follow-up (chunk verification): a chunk append that silently drops or truncates bytes must
  // not be decoded/moved into place just because what landed still happens to be valid base64. The
  // write command verifies the staged file's byte count against the expected base64 length via `wc -c`
  // before decoding.
  it('rejects the write when the staged base64 byte count does not match what was sent', async () => {
    const commands: string[] = [];
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        commands.push(cmd);
        if (cmd.includes('wc -c')) {
          // Simulate a truncated staging file (e.g. a dropped chunk) reported as size mismatch.
          return { stdout: 'AZITO_WRITE_SIZE_MISMATCH\n', stderr: '', code: 0 };
        }
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const service = new FileBrowseService(tmuxMock as any);
    const srv = { name: 'remote', type: 'ssh' } as any;

    await expect(
      service.writeFileContent(srv, '/tmp/truncated.txt', 'hello world'),
    ).rejects.toMatchObject({ status: 500 });

    const writeCmd = commands.find((c) => c.includes('wc -c'));
    expect(writeCmd).toBeDefined();
    expect(writeCmd).toContain('AZITO_WRITE_SIZE_MISMATCH');
    // The verification command still ends with a cleanup for the staging files.
    expect(writeCmd).toContain('rm -f');
  });

  it('creates the upload staging file under umask 077', async () => {
    const commands: string[] = [];
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        commands.push(cmd);
        if (cmd.includes('base64 -d <')) return { stdout: 'AZITO_WRITE_OK\n', stderr: '', code: 0 };
        if (cmd.startsWith('stat ')) return { stdout: '1750000000\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const service = new FileBrowseService(tmuxMock as any);
    const srv = { name: 'remote', type: 'ssh' } as any;

    await service.writeFileContent(srv, '/tmp/private.txt', 'secret content');

    const createCmd = commands.find((c) => c.includes(': >') && c.includes('.azito-upload-'));
    expect(createCmd).toBeDefined();
    expect(createCmd).toContain('umask 077');
    const writeCmd = commands.find((c) => c.includes('base64 -d <'));
    expect(writeCmd).toContain('umask 077');
    expect(writeCmd).toContain("trap 'rm -f");
  });

  // Review follow-up (cleanup): if a chunk append fails partway through the upload loop, the staging
  // file created just before it must still be cleaned up rather than left behind on the remote host.
  it('cleans up the staging files when a chunk append fails mid-upload', async () => {
    const commands: string[] = [];
    let chunkCalls = 0;
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        commands.push(cmd);
        if (cmd.startsWith("printf '%s'")) {
          chunkCalls++;
          if (chunkCalls === 2) throw new Error('transport dropped mid-upload');
        }
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const service = new FileBrowseService(tmuxMock as any);
    const srv = { name: 'remote', type: 'ssh' } as any;

    const bigContent = 'x'.repeat(200 * 1024); // forces multiple chunks

    await expect(
      service.writeFileContent(srv, '/tmp/interrupted.txt', bigContent),
    ).rejects.toThrow('transport dropped mid-upload');

    const cleanupCmd = commands[commands.length - 1];
    expect(cleanupCmd).toContain('rm -f');
    expect(cleanupCmd).toContain('.azito-upload-');
    expect(cleanupCmd).toContain('.azito-decoded-');
  });
});

describe('FileBrowseService.writeFileContent concurrency', () => {
  // Review follow-up (per-path serialization): the mtime check and the actual replace are separate
  // operations with an await gap between them. Without in-process serialization, two concurrent saves
  // against the same file with the same (now-stale-by-the-time-either-finishes) baseMtime could both
  // pass the conflict check and the second write would silently clobber the first. This drives two
  // concurrent local writes against the same path and asserts the second sees a 409, not a silent
  // overwrite — proving the writes were serialized rather than interleaved.
  it('serializes concurrent saves to the same path so the second sees a conflict, not a silent overwrite', async () => {
    // Uses the remote path with a mock clock instead of real local `fs` timestamps: local mtimeMs
    // granularity on some filesystems (notably under WSL2, which this repo targets — see the existing
    // "rejects a conflicting edit that landed within the same second" test's own comment on the same
    // issue) is coarse enough that two real writes issued microseconds apart can land on the identical
    // mtimeMs, which would make this test flaky for a reason unrelated to what it's actually verifying.
    // `remoteMtimeSeconds` here is an explicit, fully-controlled stand-in for "the file's mtime on disk"
    // that only advances when a write's decode/mv step actually runs, so the assertion is about call
    // ordering (serialized vs. interleaved), not about real clock resolution.
    let remoteMtimeSeconds = 100;
    const baseMtime = remoteMtimeSeconds * 1000;
    const commands: string[] = [];
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        commands.push(cmd);
        if (cmd.includes('%.Y')) return { stdout: `${remoteMtimeSeconds}.000000\n`, stderr: '', code: 0 };
        if (cmd.includes('%a')) return { stdout: '', stderr: '', code: 0 };
        if (cmd.includes('base64 -d <')) {
          // Simulates the remote write actually landing: mtime only advances here, once the decode/mv
          // step for that particular request runs — never on the initial conflict-check read.
          remoteMtimeSeconds += 1;
          return { stdout: 'AZITO_WRITE_OK\n', stderr: '', code: 0 };
        }
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const service = new FileBrowseService(tmuxMock as any);
    const srv = { name: 'remote-shared', type: 'ssh' } as any;

    // Both requests read the same baseMtime (as two browser tabs saving the same stale snapshot would).
    const [first, second] = await Promise.allSettled([
      service.writeFileContent(srv, '/tmp/shared.txt', 'edit A', baseMtime),
      service.writeFileContent(srv, '/tmp/shared.txt', 'edit B', baseMtime),
    ]);

    const results = [first, second];
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    // Exactly one decode/mv actually ran — the second request was rejected at the conflict check, before
    // ever staging or writing, not raced through to a second (corrupting) write.
    expect(commands.filter((c) => c.includes('base64 -d <')).length).toBe(1);
  });

  it('does not let one save request block unrelated files from saving concurrently', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-concurrency-'));
    const fileA = path.join(tmpDir, 'a.txt');
    const fileB = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(fileA, 'a');
    fs.writeFileSync(fileB, 'b');
    const srv = { name: 'test-local', type: 'local', directory: tmpDir } as any;
    const service = new FileBrowseService({} as any);

    const [resA, resB] = await Promise.all([
      service.writeFileContent(srv, fileA, 'new a'),
      service.writeFileContent(srv, fileB, 'new b'),
    ]);

    expect(resA.mtime).toBeGreaterThan(0);
    expect(resB.mtime).toBeGreaterThan(0);
    expect(fs.readFileSync(fileA, 'utf-8')).toBe('new a');
    expect(fs.readFileSync(fileB, 'utf-8')).toBe('new b');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('FileBrowseService.createEntry (local)', () => {
  let tmpDir: string;
  const svc = new FileBrowseService({} as any);
  const localSrv = { type: 'local', name: 'local' } as any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a file', async () => {
    const filePath = path.join(tmpDir, 'newfile.txt');
    await svc.createEntry(localSrv, filePath, 'file');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('');
  });

  it('creates a directory', async () => {
    const dirPath = path.join(tmpDir, 'newdir');
    await svc.createEntry(localSrv, dirPath, 'directory');
    expect(fs.statSync(dirPath).isDirectory()).toBe(true);
  });

  it('throws 409 if already exists', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'hello');
    await expect(svc.createEntry(localSrv, filePath, 'file')).rejects.toThrow('Already exists');
    try {
      await svc.createEntry(localSrv, filePath, 'file');
    } catch (err) {
      expect(err).toBeInstanceOf(FileBrowseError);
      expect((err as FileBrowseError).status).toBe(409);
    }
  });
});

describe('FileBrowseService.createEntry (remote)', () => {
  it('sends correct commands for file creation', async () => {
    let callCount = 0;
    const mock = {
      commands: [] as string[],
      execCommand: async (_srv: unknown, cmd: string) => {
        mock.commands.push(cmd);
        callCount++;
        if (callCount === 1) return { stdout: 'no\n', stderr: '', code: 0 };
        if (callCount === 3) return { stdout: 'ok\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const svc = new FileBrowseService(mock as any);
    const srv = { type: 'agent', name: 'test', host: 'user@host' } as any;
    await svc.createEntry(srv, '/workspace/new.txt', 'file');
    expect(mock.commands[0]).toContain('test -e');
    expect(mock.commands[1]).toContain('set -C');
  });

  it('throws 409 if remote path exists', async () => {
    const mock = createMockTmux({ 'test -e': 'yes\n' });
    const svc = new FileBrowseService(mock as any);
    const srv = { type: 'agent', name: 'test', host: 'user@host' } as any;
    await expect(svc.createEntry(srv, '/workspace/existing', 'file')).rejects.toThrow('Already exists');
  });
});

describe('FileBrowseService.deleteEntry (local)', () => {
  let tmpDir: string;
  const svc = new FileBrowseService({} as any);
  const localSrv = { type: 'local', name: 'local' } as any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes a file', async () => {
    const filePath = path.join(tmpDir, 'to-delete.txt');
    fs.writeFileSync(filePath, 'content');
    await svc.deleteEntry(localSrv, filePath);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('deletes a directory recursively', async () => {
    const dirPath = path.join(tmpDir, 'to-delete-dir');
    fs.mkdirSync(dirPath);
    fs.writeFileSync(path.join(dirPath, 'child.txt'), 'x');
    await svc.deleteEntry(localSrv, dirPath);
    expect(fs.existsSync(dirPath)).toBe(false);
  });

  it('throws 404 if not found', async () => {
    await expect(svc.deleteEntry(localSrv, path.join(tmpDir, 'nope'))).rejects.toThrow('Not found');
  });
});

describe('FileBrowseService.renameEntry (local)', () => {
  let tmpDir: string;
  const svc = new FileBrowseService({} as any);
  const localSrv = { type: 'local', name: 'local' } as any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renames a file', async () => {
    const oldPath = path.join(tmpDir, 'old.txt');
    fs.writeFileSync(oldPath, 'content');
    await svc.renameEntry(localSrv, oldPath, 'new.txt');
    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, 'new.txt'), 'utf-8')).toBe('content');
  });

  it('throws 409 if target already exists', async () => {
    const oldPath = path.join(tmpDir, 'a.txt');
    const newName = 'b.txt';
    fs.writeFileSync(oldPath, 'a');
    fs.writeFileSync(path.join(tmpDir, newName), 'b');
    await expect(svc.renameEntry(localSrv, oldPath, newName)).rejects.toThrow('Already exists');
  });

  it('throws 404 if source not found', async () => {
    await expect(svc.renameEntry(localSrv, path.join(tmpDir, 'nope'), 'new')).rejects.toThrow('Not found');
  });
});

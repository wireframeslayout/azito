import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileBrowseService, FileBrowseError } from './FileBrowseService';
import type { ServerConfig } from '../servers/Server';

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

  it('uses -- separator in cat and base64 commands', async () => {
    const mock = createMockTmux();
    const svc = new FileBrowseService(mock as any);
    const srv = { type: 'agent', name: 'test', host: 'user@host' };

    try {
      await svc.getFileContent(srv as any, '/tmp/normal.txt');
    } catch {}

    const catCmd = mock.commands.find(c => c.startsWith('cat'));
    if (catCmd) {
      expect(catCmd).toContain('cat --');
    }
  });

  // Issue #27 review Critical 1: the mtime lookup at the end of the remote
  // getFileContent() path used to interpolate filePath inside bare double
  // quotes (`stat -c%Y "${filePath}"`), which lets a path containing
  // `$(...)` execute as a subshell. Drives a full success path (typeCheck ->
  // sizeResult -> cat -> mtime) so the mtime command itself is inspected,
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
        if (cmd.startsWith('cat')) return { stdout: 'hello', stderr: '', code: 0 };
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

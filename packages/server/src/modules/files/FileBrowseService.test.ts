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
});

describe('FileBrowseService.writeFileContent (remote)', () => {
  it('splits base64 into chunks so every exec command stays under MAX_ARG_STRLEN', async () => {
    const MAX_ARG_STRLEN = 131072;
    const commands: string[] = [];
    const tmuxMock = {
      execCommand: async (_srv: unknown, cmd: string) => {
        commands.push(cmd);
        // 書き込み後の stat 検証には epoch 秒を返す
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
    // 最後にデコード + 一時ファイル削除コマンドが実行される
    expect(commands.some((c) => c.includes('base64 -d <') && c.includes('rm -f'))).toBe(true);
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

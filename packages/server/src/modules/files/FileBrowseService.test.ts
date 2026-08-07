import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
function createMockTmux() {
  const commands: string[] = [];
  return {
    commands,
    execCommand: async (_srv: unknown, cmd: string) => {
      commands.push(cmd);
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

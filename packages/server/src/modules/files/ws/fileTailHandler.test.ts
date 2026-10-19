import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WebSocket } from 'ws';
import { handleFileTail } from './fileTailHandler';
import { ManagedStreamFiles, InvalidStreamFileError } from './ManagedStreamFiles';

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: string[] = [];
  send = vi.fn((data: string) => { this.sent.push(data); });
  close = vi.fn(() => { this.readyState = 3; this.emit('close'); });
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('fileTailHandler (managed stream files)', () => {
  let dir: string;
  let managed: ManagedStreamFiles;
  let ws: FakeSocket;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-tail-'));
    managed = new ManagedStreamFiles([dir]);
    ws = new FakeSocket();
  });

  afterEach(() => {
    ws.emit('close');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const open = (filePath: string): void => handleFileTail(ws as unknown as WebSocket, filePath, managed);

  it('serves a registered file from the start and follows appends', async () => {
    const file = path.join(dir, 'azito-pipe-42-1.log');
    managed.register(file);
    fs.appendFileSync(file, 'first\n');
    open(file);
    await waitFor(() => ws.sent.join('') === 'first\n');
    fs.appendFileSync(file, 'second\n');
    await waitFor(() => ws.sent.join('') === 'first\nsecond\n');
  });

  it('refuses a file nobody registered, even one with the pipe-file name in the temp folder', () => {
    const file = path.join(dir, 'azito-pipe-42-2.log');
    fs.writeFileSync(file, 'secret\n');
    open(file);
    expect(ws.sent).toEqual([JSON.stringify({ error: 'Path not allowed' })]);
    expect(ws.close).toHaveBeenCalled();
  });

  it('refuses a path outside every temp folder', () => {
    open('/etc/passwd');
    expect(ws.sent).toEqual([JSON.stringify({ error: 'Path not allowed' })]);
  });

  it('refuses a registered path that has since been replaced by a symlink', () => {
    if (process.platform === 'win32') return; // symlink の作成に権限が要る
    const file = path.join(dir, 'azito-pipe-42-3.log');
    managed.register(file);
    const secret = path.join(dir, 'secret.txt');
    fs.writeFileSync(secret, 'secret\n');
    fs.unlinkSync(file);
    fs.symlinkSync(secret, file);
    open(file);
    expect(ws.sent).toEqual([JSON.stringify({ error: 'Path not allowed' })]);
  });

  it('sends nothing after the socket closes', async () => {
    const file = path.join(dir, 'azito-pipe-42-4.log');
    managed.register(file);
    open(file);
    ws.emit('close');
    fs.appendFileSync(file, 'late\n');
    await new Promise((r) => setTimeout(r, 600));
    expect(ws.sent).toEqual([]);
  });
});

describe('ManagedStreamFiles', () => {
  let dir: string;
  let managed: ManagedStreamFiles;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-streams-'));
    managed = new ManagedStreamFiles([dir]);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file and manages it; registering again keeps its content', () => {
    const file = path.join(dir, 'azito-pipe-7-sig-123.log');
    managed.register(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(managed.isManaged(file)).toBe(true);
    fs.writeFileSync(file, 'kept\n');
    managed.register(file);
    expect(fs.readFileSync(file, 'utf-8')).toBe('kept\n');
  });

  it.each([
    ['a relative path', 'azito-pipe-1-1.log'],
    ['a name without the pipe prefix', '/NAME/other.log'],
    ['a traversal', '/DIR/../azito-pipe-1-1.log'],
    ['a nested directory', '/DIR/sub/azito-pipe-1-1.log'],
    ['a different extension', '/DIR/azito-pipe-1-1.txt'],
  ])('rejects %s', (_label, raw) => {
    const candidate = raw.replace('/DIR', dir).replace('/NAME', dir);
    expect(() => managed.register(candidate)).toThrow(InvalidStreamFileError);
  });

  it('does not follow a symlink placed at the path', () => {
    if (process.platform === 'win32') return;
    const target = path.join(dir, 'victim.txt');
    fs.writeFileSync(target, 'v');
    const link = path.join(dir, 'azito-pipe-9-1.log');
    fs.symlinkSync(target, link);
    expect(() => managed.register(link)).toThrow();
    expect(managed.isManaged(link)).toBe(false);
  });

  it('unregister removes the file, and ignores a path that was never registered', () => {
    const file = path.join(dir, 'azito-pipe-3-1.log');
    managed.register(file);
    managed.unregister(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(managed.isManaged(file)).toBe(false);

    const other = path.join(dir, 'azito-pipe-3-2.log');
    fs.writeFileSync(other, 'x');
    managed.unregister(other);
    expect(fs.existsSync(other)).toBe(true);
  });
});

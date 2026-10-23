import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileFollower } from './FileFollower';

const POLL_MS = 20;

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('FileFollower', () => {
  let dir: string;
  let file: string;
  let follower: FileFollower | null;
  let received: string;
  const errors: Error[] = [];

  function follow(): FileFollower {
    follower = new FileFollower(file, { onData: (t) => { received += t; }, onError: (e) => errors.push(e), pollIntervalMs: POLL_MS });
    follower.start();
    return follower;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-follower-'));
    file = path.join(dir, 'f.log');
    received = '';
    errors.length = 0;
    follower = null;
  });

  afterEach(() => {
    follower?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the existing content from the start, then follows appends', async () => {
    fs.writeFileSync(file, 'one\n');
    follow();
    await waitFor(() => received === 'one\n');
    fs.appendFileSync(file, 'two\n');
    await waitFor(() => received === 'one\ntwo\n');
    fs.appendFileSync(file, 'three\n');
    await waitFor(() => received === 'one\ntwo\nthree\n');
  });

  it('starts from an empty file and picks up what is written later', async () => {
    fs.writeFileSync(file, '');
    follow();
    fs.appendFileSync(file, 'late\n');
    await waitFor(() => received === 'late\n');
  });

  it('rereads from the start when the file is truncated', async () => {
    fs.writeFileSync(file, 'aaaaaaaaaa\n');
    follow();
    await waitFor(() => received === 'aaaaaaaaaa\n');
    fs.truncateSync(file, 0);
    fs.appendFileSync(file, 'b\n');
    await waitFor(() => received === 'aaaaaaaaaa\nb\n');
  });

  it('does not garble a multi-byte character split across reads', async () => {
    const bytes = Buffer.from('日本語🙂\n', 'utf-8');
    // Split inside a 3-byte character and again inside the 4-byte emoji.
    fs.writeFileSync(file, bytes.subarray(0, 4));
    follow();
    await waitFor(() => received === '日');
    fs.appendFileSync(file, bytes.subarray(4, 11));
    fs.appendFileSync(file, bytes.subarray(11));
    await waitFor(() => received === '日本語🙂\n');
    expect(received).not.toContain('�');
  });

  it('reads a large file completely', async () => {
    const line = 'A'.repeat(99) + '\n';
    const content = line.repeat(25000);
    fs.writeFileSync(file, content);
    follow();
    await waitFor(() => received.length === content.length);
    expect(received).toBe(content);
  });

  it('throws on start when the file does not exist, like `tail -f` exiting', () => {
    follower = new FileFollower(path.join(dir, 'missing.log'), { onData: () => {} });
    expect(() => follower!.start()).toThrow(/ENOENT/);
  });

  it('keeps following the opened file after it is unlinked (descriptor following)', async () => {
    if (process.platform === 'win32') return; // 開いたままのファイルを削除できない
    fs.writeFileSync(file, 'x\n');
    follow();
    await waitFor(() => received === 'x\n');
    fs.unlinkSync(file);
    await new Promise((r) => setTimeout(r, POLL_MS * 3));
    expect(errors).toHaveLength(0);
  });

  it('emits nothing after stop, even when the file keeps growing', async () => {
    fs.writeFileSync(file, 'a\n');
    const f = follow();
    await waitFor(() => received === 'a\n');
    f.stop();
    fs.appendFileSync(file, 'b\n');
    await new Promise((r) => setTimeout(r, POLL_MS * 5));
    expect(received).toBe('a\n');
  });

  it('releases the file descriptor and timers on stop', async () => {
    fs.writeFileSync(file, 'a\n');
    const handlesBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const f = follow();
    expect(process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length).toBeGreaterThan(handlesBefore);
    f.stop();
    expect(process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length).toBe(handlesBefore);
    // The file can be deleted right after stop (on Windows this fails while the fd is still open).
    fs.unlinkSync(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('stop is idempotent and stopping from inside onData is safe', async () => {
    fs.writeFileSync(file, 'a\n');
    const seen: string[] = [];
    const f = new FileFollower(file, { onData: (t) => { seen.push(t); f.stop(); }, pollIntervalMs: POLL_MS });
    follower = f;
    f.start();
    f.stop();
    fs.appendFileSync(file, 'b\n');
    await new Promise((r) => setTimeout(r, POLL_MS * 3));
    expect(seen).toEqual(['a\n']);
  });

  it('stops and reports an onData that throws, instead of letting it escape from a timer', async () => {
    fs.writeFileSync(file, '');
    let calls = 0;
    follower = new FileFollower(file, {
      onData: () => { calls++; throw new Error('boom'); },
      onError: (e) => errors.push(e),
      pollIntervalMs: POLL_MS,
    });
    follower.start();
    fs.appendFileSync(file, 'a\n');
    await waitFor(() => errors.length === 1);
    fs.appendFileSync(file, 'b\n');
    await new Promise((r) => setTimeout(r, POLL_MS * 4));
    expect(errors[0].message).toBe('boom');
    expect(calls).toBe(1);
  });

  it('cannot be started twice', () => {
    fs.writeFileSync(file, '');
    const f = follow();
    expect(() => f.start()).toThrow(/already started/);
  });
});

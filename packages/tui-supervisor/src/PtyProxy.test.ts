import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PtyProxy, type PtyExitInfo } from './PtyProxy';

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('PtyProxy (real processes)', () => {
  let stdoutSpy: MockInstance;
  let exitSpy: MockInstance;
  let output: string;

  beforeEach(() => {
    output = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  function startProxy(cmd: string): { proxy: PtyProxy; exited: () => PtyExitInfo | undefined } {
    const proxy = new PtyProxy();
    let exitInfo: PtyExitInfo | undefined;
    proxy.on('exit', (info: PtyExitInfo) => {
      exitInfo = info;
    });
    proxy.start(cmd);
    return { proxy, exited: () => exitInfo };
  }

  it('forwards child output to stdout', async () => {
    const { exited } = startProxy('echo hello-pty-proxy');
    await waitFor(() => exited() !== undefined);
    expect(output).toContain('hello-pty-proxy');
  });

  it('propagates a normal exit code', async () => {
    const { exited } = startProxy('exit 3');
    await waitFor(() => exited() !== undefined);
    expect(exited()).toEqual({ exitCode: 3, signal: null, code: 3 });
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('reports 128+signal when the child dies from a signal', async () => {
    const { proxy, exited } = startProxy('sleep 100');
    await new Promise((r) => setTimeout(r, 300));
    proxy.kill('SIGINT');
    await waitFor(() => exited() !== undefined);
    expect(exited()).toEqual({ exitCode: null, signal: 2, code: 130 });
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('resize changes the child PTY size (observed via stty size)', async () => {
    const { proxy, exited } = startProxy('sleep 0.5; stty size');
    await new Promise((r) => setTimeout(r, 150));
    proxy.resize(100, 40);
    await waitFor(() => exited() !== undefined);
    expect(output).toContain('40 100');
  });

  it('delivers bracketed paste writes literally to the child (cat)', async () => {
    const { proxy, exited } = startProxy('cat');
    await new Promise((r) => setTimeout(r, 300));
    proxy.write('\x1b[200~line-one\nline-two\x1b[201~\n');
    await waitFor(() => output.includes('line-one') && output.includes('line-two'));
    // EOF to end cat (twice: flush pending partial line, then EOF).
    proxy.write('\x04');
    proxy.write('\x04');
    await waitFor(() => exited() !== undefined);
    expect(output).toContain('line-one');
    expect(output).toContain('line-two');
  });

  it('preserves non-UTF-8 byte sequences written to the child (no U+FFFD mangling)', async () => {
    // 0xff 0xfe 0x80 is invalid UTF-8; a utf8 string round-trip would replace it
    // with EF BF BD (U+FFFD). od reports the bytes the child actually received.
    const { proxy, exited } = startProxy('head -c 3 | od -An -tx1');
    await new Promise((r) => setTimeout(r, 300));
    proxy.write(Buffer.from([0xff, 0xfe, 0x80, 0x0a]));
    await waitFor(() => exited() !== undefined);
    const normalized = output.replace(/\s+/g, ' ');
    expect(normalized).toContain('ff fe 80');
    expect(normalized).not.toContain('ef bf bd');
  });

  it('delivers Japanese text intact, even split mid-character across writes', async () => {
    const { proxy, exited } = startProxy('cat');
    await new Promise((r) => setTimeout(r, 300));
    const bytes = Buffer.from('日本語テスト\n', 'utf8');
    // Split inside the first multibyte character (日 = e6 97 a5).
    proxy.write(bytes.subarray(0, 2));
    proxy.write(bytes.subarray(2));
    await waitFor(() => output.includes('日本語テスト'));
    proxy.write('\x04');
    await waitFor(() => exited() !== undefined);
    expect(output).toContain('日本語テスト');
  });

  it('emits data events with byte counts', async () => {
    const proxy = new PtyProxy();
    let bytes = 0;
    let done = false;
    proxy.on('data', (n: number) => {
      bytes += n;
    });
    proxy.on('exit', () => {
      done = true;
    });
    proxy.start('echo 12345');
    await waitFor(() => done);
    expect(bytes).toBeGreaterThanOrEqual(6);
  });
});

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { buildLoginShellCommand, PtyProxy, type PtyExitInfo } from './PtyProxy';

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('buildLoginShellCommand', () => {
  it('re-exports TMUX and TMUX_PANE ahead of the command', () => {
    const cmd = buildLoginShellCommand('claude --resume', {
      TMUX: '/tmp/tmux-1000/default,1234,0',
      TMUX_PANE: '%273',
    });
    expect(cmd).toBe(`export TMUX='/tmp/tmux-1000/default,1234,0' TMUX_PANE='%273'; claude --resume`);
  });

  it('injects nothing when the variables are absent (outside tmux)', () => {
    expect(buildLoginShellCommand('claude', {})).toBe('claude');
  });

  it('injects nothing when the variables are empty strings', () => {
    expect(buildLoginShellCommand('claude', { TMUX: '', TMUX_PANE: '' })).toBe('claude');
  });

  it('injects only the variables that are present', () => {
    expect(buildLoginShellCommand('claude', { TMUX_PANE: '%1' })).toBe(`export TMUX_PANE='%1'; claude`);
  });

  it('escapes single quotes in values', () => {
    expect(buildLoginShellCommand('claude', { TMUX_PANE: `%1'; rm -rf /; echo '` })).toBe(
      `export TMUX_PANE='%1'\\''; rm -rf /; echo '\\'''; claude`,
    );
  });

  it('produces a string a shell evaluates back to the original value', () => {
    const value = `weird'"$( )value`;
    const cmd = buildLoginShellCommand('printf %s "$TMUX_PANE"', { TMUX_PANE: value });
    expect(execFileSync('/bin/bash', ['-c', cmd], { encoding: 'utf-8' })).toBe(value);
  });
});

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

  // Regression guard for the hook blackout under a supervisor: `-lc` evaluates the
  // login profile, and profiles commonly `unset TMUX TMUX_PANE` (they treat them as
  // stale inheritance). The pane identity must survive that, or Claude Code's hooks
  // can no longer resolve their pane. The profile is simulated with a throwaway HOME
  // so the test fails on the pre-fix implementation regardless of the host's dotfiles
  // (which may well keep the variables and make a naive assertion vacuous).
  it('restores TMUX/TMUX_PANE even when the login profile unsets them', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-proxy-home-'));
    fs.writeFileSync(path.join(home, '.bash_profile'), 'unset TMUX TMUX_PANE\n');
    const saved = { HOME: process.env.HOME, SHELL: process.env.SHELL, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
    process.env.HOME = home;
    process.env.SHELL = '/bin/bash'; // bash reads ~/.bash_profile for a login shell
    process.env.TMUX = '/tmp/tmux-test/default,4242,0';
    process.env.TMUX_PANE = '%4242';
    try {
      // Sanity: the simulated profile really does unset the variables, so a pass
      // below can only come from the re-export (not from a no-op profile).
      const bare = execFileSync('/bin/bash', ['-lc', 'echo "bare=[$TMUX_PANE]"'], { env: process.env, encoding: 'utf-8' });
      expect(bare).toContain('bare=[]');

      const { exited } = startProxy('echo "pane=[$TMUX_PANE] sock=[$TMUX]"');
      await waitFor(() => exited() !== undefined);
      expect(output).toContain('pane=[%4242]');
      expect(output).toContain('sock=[/tmp/tmux-test/default,4242,0]');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
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

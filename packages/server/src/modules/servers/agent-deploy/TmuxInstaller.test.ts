import { describe, it, expect } from 'vitest';
import { TmuxInstaller } from './TmuxInstaller';
import type { IHostBoundTransport, IServerTransport } from '../transport/ServerTransport';
import type { HostProfile } from '../../../shared/os/hostProfile';

interface Recorded {
  transport: IServerTransport & IHostBoundTransport;
  execs: string[];
  runs: string[];
}

/** A transport that has a recorded host profile (no OS probe) or, with null, answers the `uname` probes like a Unix agent from before the OS was recorded. */
function makeTransport(hostProfile: HostProfile | null, uname: { s: string; m: string } = { s: 'Linux', m: 'x86_64' }): Recorded {
  const execs: string[] = [];
  const runs: string[] = [];
  const transport = {
    hostProfile,
    run: async (spec: { file: string; args: string[] }) => {
      runs.push([spec.file, ...spec.args].join(' '));
      const flag = spec.args[0];
      return { exitCode: 0, signal: null, stdout: `${flag === '-s' ? uname.s : uname.m}\n`, stderr: '' };
    },
    exec: async (cmd: string) => {
      execs.push(cmd);
      if (cmd.includes('sha256sum')) return { stdout: 'badhash  /path\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
    execMux: async () => ({ stdout: '', stderr: '', code: 0 }),
    openTerminal: async () => { throw new Error('not implemented'); },
    createPaneStream: () => { throw new Error('not implemented'); },
  } as unknown as IServerTransport & IHostBoundTransport;
  return { transport, execs, runs };
}

describe('TmuxInstaller', () => {
  it('fails fast on sha256 mismatch, reading the OS from the recorded profile (no probe)', async () => {
    const { transport, execs, runs } = makeTransport({ platform: 'linux', arch: 'x64' });
    const result = await new TmuxInstaller().install(transport);
    expect(result.success).toBe(false);
    expect(result.error).toContain('SHA256 mismatch');
    expect(execs.some((c) => c.includes('rm -f'))).toBe(true);
    expect(execs.some((c) => c.includes('mv'))).toBe(false);
    expect(runs).toEqual([]);
    expect(execs.some((c) => c.includes('echo $HOME'))).toBe(false);
  });

  it('puts the files under $HOME, which sh expands', async () => {
    const { transport, execs } = makeTransport({ platform: 'linux', arch: 'x64' });
    await new TmuxInstaller().install(transport);
    expect(execs).toContain('mkdir -p "$HOME/.azito/tmux/bin"');
  });

  it('rejects a non-Linux recorded OS', async () => {
    const { transport, execs } = makeTransport({ platform: 'darwin', arch: 'arm64' });
    const result = await new TmuxInstaller().install(transport);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Linux のみ対応');
    expect(execs).toEqual([]);
  });

  it('maps a recorded arm64 to the aarch64 binary', async () => {
    const { transport, execs } = makeTransport({ platform: 'linux', arch: 'arm64' });
    const result = await new TmuxInstaller().install(transport);
    expect(result.error).toContain('SHA256 mismatch');
    expect(execs.some((c) => c.includes('tmux-linux-arm64'))).toBe(true);
  });

  it('asks a host with no recorded profile (an agent from before the OS was kept) with uname', async () => {
    const { transport, runs } = makeTransport(null, { s: 'Linux', m: 'arm64' });
    const result = await new TmuxInstaller().install(transport);
    expect(result.error).toContain('SHA256 mismatch');
    expect(runs).toEqual(['uname -s', 'uname -m']);
  });

  it('rejects a non-Linux OS reported by the probe of an unrecorded host', async () => {
    const { transport } = makeTransport(null, { s: 'Darwin', m: 'arm64' });
    const result = await new TmuxInstaller().install(transport);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Linux のみ対応');
  });

  it('refuses a win32 server with unsupported_os before running anything', async () => {
    const { transport, execs, runs } = makeTransport({ platform: 'win32', arch: 'x64' });
    await expect(new TmuxInstaller().install(transport)).rejects.toMatchObject({ name: 'HostProfileError', code: 'unsupported_os', message: expect.stringContaining('installing tmux') });
    expect(execs).toEqual([]);
    expect(runs).toEqual([]);
  });
});

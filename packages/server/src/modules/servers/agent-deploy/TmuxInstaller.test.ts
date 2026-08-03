import { describe, it, expect } from 'vitest';
import { TmuxInstaller } from './TmuxInstaller';
import type { IServerTransport } from '../transport/ServerTransport';

describe('TmuxInstaller', () => {
  it('fails fast on sha256 mismatch', async () => {
    const commands: string[] = [];
    const mockTransport = {
      exec: async (cmd: string) => {
        commands.push(cmd);
        if (cmd === 'uname -s') return { stdout: 'Linux\n', stderr: '', code: 0 };
        if (cmd === 'uname -m') return { stdout: 'x86_64\n', stderr: '', code: 0 };
        if (cmd.includes('echo $HOME')) return { stdout: '/home/test\n', stderr: '', code: 0 };
        if (cmd.includes('mkdir')) return { stdout: '', stderr: '', code: 0 };
        if (cmd.includes('curl')) return { stdout: '', stderr: '', code: 0 };
        if (cmd.includes('sha256sum')) return { stdout: 'badhash  /path\n', stderr: '', code: 0 };
        if (cmd.includes('rm -f')) return { stdout: '', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
      execTmux: async () => ({ stdout: '', stderr: '', code: 0 }),
      openTerminal: async () => { throw new Error('not implemented'); },
      createPaneStream: () => { throw new Error('not implemented'); },
    } as unknown as IServerTransport;

    const installer = new TmuxInstaller();
    const result = await installer.install(mockTransport);
    expect(result.success).toBe(false);
    expect(result.error).toContain('SHA256 mismatch');
    expect(commands.some(c => c.includes('rm -f'))).toBe(true);
    expect(commands.some(c => c.includes('mv'))).toBe(false);
  });

  it('rejects non-Linux OS', async () => {
    const mockTransport = {
      exec: async (cmd: string) => {
        if (cmd === 'uname -s') return { stdout: 'Darwin\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
      execTmux: async () => ({ stdout: '', stderr: '', code: 0 }),
      openTerminal: async () => { throw new Error('not implemented'); },
      createPaneStream: () => { throw new Error('not implemented'); },
    } as unknown as IServerTransport;

    const installer = new TmuxInstaller();
    const result = await installer.install(mockTransport);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Linux のみ対応');
  });

  it('normalizes arm64 to aarch64', async () => {
    const commands: string[] = [];
    const mockTransport = {
      exec: async (cmd: string) => {
        commands.push(cmd);
        if (cmd === 'uname -s') return { stdout: 'Linux\n', stderr: '', code: 0 };
        if (cmd === 'uname -m') return { stdout: 'arm64\n', stderr: '', code: 0 };
        if (cmd.includes('echo $HOME')) return { stdout: '/home/test\n', stderr: '', code: 0 };
        if (cmd.includes('mkdir')) return { stdout: '', stderr: '', code: 0 };
        if (cmd.includes('curl')) return { stdout: '', stderr: '', code: 0 };
        if (cmd.includes('sha256sum')) return { stdout: 'badhash  /path\n', stderr: '', code: 0 };
        if (cmd.includes('rm -f')) return { stdout: '', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
      execTmux: async () => ({ stdout: '', stderr: '', code: 0 }),
      openTerminal: async () => { throw new Error('not implemented'); },
      createPaneStream: () => { throw new Error('not implemented'); },
    } as unknown as IServerTransport;

    const installer = new TmuxInstaller();
    const result = await installer.install(mockTransport);
    expect(result.success).toBe(false);
    expect(result.error).toContain('SHA256 mismatch');
    expect(commands.some(c => c.includes('arm64'))).toBe(true);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { HarnessInstaller } from './HarnessInstaller';
import { unpackTarGz } from '../../../shared/fs/tarGz';
import type { SshClient } from '../ssh/SshClient';

// The harness archive is packed on the hub and unpacked on a Linux / macOS host. Its modes must not depend on the hub's file
// system (a Windows one has no execute bit), so they are checked on the bytes handed to SFTP.
describe('HarnessInstaller — the harness archive sent to the host', () => {
  it('is rooted at harness/, leaves node_modules out and marks every #! script executable', async () => {
    const sshClient = { execIsolated: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })) } as unknown as SshClient;
    const installer = new HarnessInstaller(sshClient);
    const sftpWrite = vi.spyOn(installer as unknown as { sftpWrite: (host: string, data: Buffer, remote: string) => Promise<void> }, 'sftpWrite').mockResolvedValue(undefined);

    await (installer as unknown as { transferHarness: (host: string) => Promise<void> }).transferHarness('user@host');

    expect(sftpWrite).toHaveBeenCalledTimes(1);
    const [, data, remotePath] = sftpWrite.mock.calls[0];
    expect(remotePath).toMatch(/^\/tmp\/azito-harness-\d+\.tar\.gz$/);
    const entries = unpackTarGz(data);
    expect(entries[0]).toMatchObject({ path: 'harness', type: 'directory', mode: 0o755 });
    expect(entries.every((e) => e.path === 'harness' || e.path.startsWith('harness/'))).toBe(true);
    expect(entries.some((e) => e.path.includes('node_modules'))).toBe(false);

    const files = entries.filter((e) => e.type === 'file');
    expect(files.find((e) => e.path === 'harness/setup.sh')?.mode).toBe(0o755);
    for (const file of files) {
      const isScript = file.data!.subarray(0, 2).toString() === '#!';
      expect(file.mode, file.path).toBe(isScript ? 0o755 : 0o644);
    }
    expect(files.find((e) => e.path === 'harness/hooks/azito-activity.sh')?.mode).toBe(0o755);
  });
});

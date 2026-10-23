import { describe, expect, it, vi } from 'vitest';
import { MisaoAgentInstaller, type MisaoInstallTarget } from './MisaoAgentInstaller';

function target(hostProfile: MisaoInstallTarget['hostProfile']): MisaoInstallTarget {
  return {
    hostProfile,
    exec: vi.fn(),
    fetchMisaoStatus: vi.fn(),
    uploadMisaoFile: vi.fn(),
  } as unknown as MisaoInstallTarget;
}

// The install is sh (chmod, mv, ln, systemd, nohup): a Windows agent is refused before anything is asked of it.
describe('MisaoAgentInstaller on a Windows agent', () => {
  for (const action of ['install', 'update'] as const) {
    it(`${action} is refused with unsupported_os and touches nothing`, async () => {
      const win = target({ platform: 'win32', arch: 'x64' });
      const installer = new MisaoAgentInstaller(null);
      await expect(installer[action](win)).rejects.toMatchObject({ code: 'unsupported_os', message: expect.stringContaining('installing misao') });
      expect(win.exec).not.toHaveBeenCalled();
      expect(win.fetchMisaoStatus).not.toHaveBeenCalled();
    });

    it(`${action} does not refuse an agent with no recorded OS (a Unix one): it goes on to its own checks`, async () => {
      const unrecorded = target(null);
      const installer = new MisaoAgentInstaller(null);
      await expect(installer[action](unrecorded)).rejects.toMatchObject({ code: 'not_managed' });
    });
  }
});

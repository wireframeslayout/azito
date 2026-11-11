import { describe, expect, it } from 'vitest';
import { UninstallPreparationError, withUninstallPreparation } from './windowsHubUninstallCommand';

describe('uninstall preparation errors', () => {
  it('reports a refusal before task deletion without claiming anything was removed', async () => {
    const action = withUninstallPreparation(async () => { throw new Error('hub process is still running'); });
    await expect(action).rejects.toMatchObject({ message: 'hub process is still running', taskMayHaveBeenRemoved: false });
  });

  it('reports a failure after deletion may have started', async () => {
    const action = withUninstallPreparation(async (beforeDelete) => { beforeDelete(); throw new Error('record failed'); });
    await expect(action).rejects.toBeInstanceOf(UninstallPreparationError);
    await expect(action).rejects.toMatchObject({ message: 'record failed', taskMayHaveBeenRemoved: true });
  });
});

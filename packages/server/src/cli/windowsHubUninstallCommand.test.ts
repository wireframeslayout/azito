import { describe, expect, it } from 'vitest';
import { UninstallPreparationError, withUninstallPreparation } from './windowsHubUninstallCommand';

describe('uninstall preparation errors', () => {
  it('treats retained items as a successful preparation', async () => {
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      const result = await withUninstallPreparation(async () => ({ retained: ['data retained', 'PATH not recorded'] }));
      expect(result.retained).toHaveLength(2);
      expect(process.exitCode).toBe(0);
    } finally { process.exitCode = previous; }
  });

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

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'stream';
import { UninstallPreparationError, withUninstallPreparation, confirmUninstall } from './windowsHubUninstallCommand';

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

describe('uninstall confirmation protocol', () => {
  async function check(chunks: Buffer[]) {
    const input = new PassThrough();
    const messages: string[] = [];
    let exitCode = 0;
    const result = confirmUninstall(input, (message) => messages.push(message), () => { exitCode = 1; });
    for (const chunk of chunks) input.write(chunk);
    input.end();
    return { proceed: await result, messages: messages.map((message) => JSON.parse(message)), exitCode };
  }

  it('accepts a BOM and CRLF', async () => {
    expect(await check([Buffer.from('\uFEFFremove\r\n')])).toEqual({ proceed: true, messages: [], exitCode: 0 });
  });

  it('assembles a line split across chunks', async () => {
    expect(await check([Buffer.from('re'), Buffer.from('move\n')])).toEqual({ proceed: true, messages: [], exitCode: 0 });
  });

  it('reports end without input as a cancellation', async () => {
    expect(await check([])).toEqual({ proceed: false, messages: [{ removed: false, error: 'cancelled' }], exitCode: 1 });
  });

  it('reports unexpected input with a nonzero status', async () => {
    expect(await check([Buffer.from('nope\n')])).toEqual({ proceed: false, messages: [{ removed: false, error: 'unexpected uninstall action: "nope"' }], exitCode: 1 });
  });
});

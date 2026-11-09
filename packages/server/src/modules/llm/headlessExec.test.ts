import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { runHeadlessCommand } from './headlessExec';

describe.skipIf(process.platform === 'win32')('headless command failure classification', () => {
  it('distinguishes missing binary, authentication and timeout', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'headless-test-'));
    try {
      await expect(runHeadlessCommand('azito-nonexistent-test-command', [], cwd, '')).rejects.toMatchObject({ reason: 'not_installed' });
      await expect(runHeadlessCommand('/bin/sh', ['-c', 'echo "not logged in" >&2; exit 1'], cwd, '')).rejects.toMatchObject({ reason: 'not_authenticated' });
      await expect(runHeadlessCommand('/bin/sh', ['-c', 'sleep 10'], cwd, '', 20)).rejects.toMatchObject({ reason: 'timeout' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

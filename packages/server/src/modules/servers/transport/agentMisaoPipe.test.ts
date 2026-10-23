import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalHostPath, windowsMisaoPipe } from './agentMisaoSocket';

describe('the pipe name follows the folder, not its spelling', () => {
  let dir: string;
  beforeEach(() => { dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'azp-'))); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Windows's own short names (RUNNER~1) are what the real CI checks (smoke-misao-win32.ts); a link is the same case on any OS here.
  it.skipIf(process.platform === 'win32')('gives a link to a folder the pipe of the folder itself', () => {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(real, alias, 'dir');
    expect(canonicalHostPath(alias)).toBe(real);
    expect(windowsMisaoPipe(alias, 'dev')).toBe(windowsMisaoPipe(real, 'dev'));
  });

  it('leaves a folder that does not exist as it is', () => {
    expect(canonicalHostPath(path.join(dir, 'nope'))).toBe(path.join(dir, 'nope'));
  });
});

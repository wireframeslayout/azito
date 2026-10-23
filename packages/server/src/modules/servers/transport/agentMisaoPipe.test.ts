import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { windowsMisaoPipe } from './agentMisaoSocket';
import { resolveRealPath } from '../../../shared/os/realPath';

describe('the pipe name follows the folder, not its spelling (the owner of the folder resolves it once)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'azp-'))); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Windows's own short names (RUNNER~1) are what the real CI checks (smoke-misao-win32.ts); a link is the same case on any OS here.
  it.skipIf(process.platform === 'win32')('gives a link to a folder, and the not yet created folder inside it, the pipe of the real folder, before and after it is created', () => {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(real, alias, 'dir');
    const beforeCreate = windowsMisaoPipe(resolveRealPath(path.join(alias, '.azito', 'misao')), 'dev');
    fs.mkdirSync(path.join(real, '.azito', 'misao'), { recursive: true });
    const afterCreate = windowsMisaoPipe(resolveRealPath(path.join(alias, '.azito', 'misao')), 'dev');
    expect(beforeCreate).toBe(afterCreate);
    expect(afterCreate).toBe(windowsMisaoPipe(path.join(real, '.azito', 'misao'), 'dev'));
  });

  it.skipIf(process.platform === 'win32')('gives the root of misao itself being a link the pipe of where it really is, the same string an agent reports', () => {
    const real = path.join(dir, 'real-misao');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(dir, 'misao'), 'dir');
    expect(resolveRealPath(path.join(dir, 'misao'))).toBe(real);
    expect(windowsMisaoPipe(resolveRealPath(path.join(dir, 'misao')), 'dev')).toBe(windowsMisaoPipe(real, 'dev'));
  });

  it('is a pure function of the string: a path of another host is never looked up on this one', () => {
    expect(windowsMisaoPipe('C:\\Users\\RUNNER~1\\.azito\\misao', 'dev')).not.toBe(windowsMisaoPipe('C:\\Users\\runneradmin\\.azito\\misao', 'dev'));
    expect(windowsMisaoPipe('C:\\Users\\Dev\\.azito\\misao', 'dev')).toBe(windowsMisaoPipe('c:\\users\\dev\\.azito\\misao', 'dev'));
  });
});

describe('resolveRealPath', () => {
  let dir: string;
  beforeEach(() => { dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'azr-'))); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('joins the part that does not exist to the resolved nearest ancestor, and leaves an existing folder as its real path', () => {
    expect(resolveRealPath(path.join(dir, 'a', 'b'))).toBe(path.join(dir, 'a', 'b'));
    expect(resolveRealPath(dir)).toBe(dir);
  });

  it.skipIf(process.platform === 'win32')('resolves a link in the existing part only', () => {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(dir, 'alias'), 'dir');
    expect(resolveRealPath(path.join(dir, 'alias', 'x', 'y'))).toBe(path.join(real, 'x', 'y'));
  });

  it('returns the root of a file system as it is', () => {
    const root = path.parse(dir).root;
    expect(resolveRealPath(root)).toBe(fs.realpathSync.native(root));
  });
});

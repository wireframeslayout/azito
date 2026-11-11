import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readInstallInventory } from '../windowsInstallInventory';

const roots: string[] = [];
function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-inventory-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('readInstallInventory', () => {
  it('records files, content and empty directories deterministically', () => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'empty'));
    fs.writeFileSync(path.join(root, 'file'), 'content');
    expect(readInstallInventory(root)).toEqual({
      directories: ['empty'],
      files: [{ path: 'file', sha256: crypto.createHash('sha256').update('content').digest('hex') }],
    });
  });

  it('refuses to enter a symlink', () => {
    const root = temp();
    fs.symlinkSync(temp(), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => readInstallInventory(root)).toThrow(/link/);
  });

  it('refuses a symlink in the path to the root', () => {
    const root = temp();
    const real = temp();
    fs.mkdirSync(path.join(real, 'nested'));
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => readInstallInventory(path.join(link, 'nested'))).toThrow(/link/);
  });
});

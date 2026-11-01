import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDistributionInfo } from './distributionInfo';
import { resolveStorageOnboarding } from '../modules/files/storageOnboarding';

describe('distribution information', () => {
  it('uses OSS onboarding when the file or onboarding is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-distribution-'));
    try {
      expect(resolveStorageOnboarding(getDistributionInfo(dir)).source).toBe('oss');
      fs.writeFileSync(path.join(dir, 'distribution.json'), '{}');
      expect(resolveStorageOnboarding(getDistributionInfo(dir)).source).toBe('oss');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects invalid JSON and invalid options', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-distribution-'));
    const file = path.join(dir, 'distribution.json');
    try {
      fs.writeFileSync(file, '{');
      expect(() => getDistributionInfo(dir)).toThrow();
      fs.writeFileSync(file, JSON.stringify({ storage: { onboarding: { options: [{ type: 'link', title: 'x', description: 'x', url: 'javascript:alert(1)' }] } } }));
      expect(() => getDistributionInfo(dir)).toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

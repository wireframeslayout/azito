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
  it('reads a distribution onboarding and applies the dismissible default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-distribution-'));
    try {
      fs.writeFileSync(path.join(dir, 'distribution.json'), JSON.stringify({ storage: { onboarding: { heading: 'Heading', body: 'Body', options: [{ id: 'managed', kind: 'managed', title: 'Managed', description: '', defaults: { endpoint: 'https://example.com', bucket: 'files' } }] } } }));
      expect(resolveStorageOnboarding(getDistributionInfo(dir))).toMatchObject({ source: 'distribution', heading: 'Heading', dismissible: true, options: [{ kind: 'managed', defaults: { bucket: 'files' } }] });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects invalid JSON and invalid options', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-distribution-'));
    const file = path.join(dir, 'distribution.json');
    try {
      fs.writeFileSync(file, '{');
      expect(() => getDistributionInfo(dir)).toThrow();
      fs.writeFileSync(file, JSON.stringify({ storage: { onboarding: { heading: 'Heading', body: 'Body', options: [{ id: 'x', kind: 'link', title: 'x', description: 'x', href: 'javascript:alert(1)' }] } } }));
      expect(() => getDistributionInfo(dir)).toThrow();
      const onboarding = (options: unknown[]) => JSON.stringify({ storage: { onboarding: { heading: 'Heading', body: 'Body', options } } });
      fs.writeFileSync(file, onboarding([{ id: 'x', kind: 'link', title: 'x', description: 'x' }]));
      expect(() => getDistributionInfo(dir)).toThrow();
      fs.writeFileSync(file, onboarding([{ id: 'x', kind: 'managed', title: 'x', description: 'x' }]));
      expect(() => getDistributionInfo(dir)).toThrow();
      fs.writeFileSync(file, onboarding([{ id: 'x', kind: 'connect-s3', title: 'x', description: 'x' }, { id: 'x', kind: 'local-minio', title: 'y', description: 'y' }]));
      expect(() => getDistributionInfo(dir)).toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { StorageStatusService } from './StorageStatusService';
import { resolveStorageOnboarding } from '../storageOnboarding';
import type { IStorageSettingsRepository } from '../SqliteStorageSettingsRepository';
import type { StorageSettings } from './MinioStorageClient';

const settings: StorageSettings = { endpoint: 'http://localhost:9000', accessKey: 'a', secretKey: 'b', bucket: 'bucket', region: 'us-east-1', maxFileSize: 1, useSsl: false };
function repo(configured: boolean): IStorageSettingsRepository {
  return { get: () => settings, update: vi.fn(), isConfigured: () => configured, markConfigured: vi.fn() };
}
describe('StorageStatusService', () => {
  it('marks a successful default connection configured', async () => {
    const repository = repo(false);
    const service = new StorageStatusService(repository, { probe: async () => {} }, resolveStorageOnboarding(null));
    expect(await service.getStatus()).toEqual({ status: 'ready' });
    expect(repository.markConfigured).toHaveBeenCalledOnce();
  });
  it('offers onboarding for an unconfigured failed connection', async () => {
    const service = new StorageStatusService(repo(false), { probe: async () => { throw new Error('secret'); } }, resolveStorageOnboarding(null));
    expect(await service.getStatus()).toMatchObject({ status: 'unconfigured', onboarding: { source: 'oss' } });
  });
  it('classifies configured failures without leaking details', async () => {
    const service = new StorageStatusService(repo(true), { probe: async () => { throw Object.assign(new Error('secret'), { name: 'AccessDenied' }); } }, resolveStorageOnboarding(null));
    expect(await service.getStatus()).toEqual({ status: 'unreachable', reason: 'authentication', message: 'Storage is unavailable. Check the connection settings and try again.' });
  });
});

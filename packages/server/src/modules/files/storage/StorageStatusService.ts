import type { IStorageSettingsRepository } from '../SqliteStorageSettingsRepository';
import type { ResolvedStorageOnboarding } from '../storageOnboarding';
import type { StorageSettings } from './MinioStorageClient';
import { classifyStorageError, type StorageErrorCode } from './storageErrors';

export type StorageStatus =
  | { state: 'ready' }
  | { state: 'unconfigured'; onboarding: ResolvedStorageOnboarding }
  | { state: 'unreachable'; reason: StorageErrorCode; message: string };

interface StorageProbe { probe(settings: StorageSettings): Promise<void> }

export class StorageStatusService {
  constructor(private readonly settings: IStorageSettingsRepository, private readonly client: StorageProbe, private readonly onboarding: ResolvedStorageOnboarding) {}

  async getStatus(): Promise<StorageStatus> {
    const settings = this.settings.get();
    try {
      await this.client.probe(settings);
    } catch (error) {
      if (!this.settings.isConfigured()) return { state: 'unconfigured', onboarding: this.onboarding };
      const failure = classifyStorageError(error);
      return { state: 'unreachable', reason: failure.code, message: failure.error };
    }
    if (!this.settings.isConfigured()) this.settings.markConfigured();
    return { state: 'ready' };
  }
}

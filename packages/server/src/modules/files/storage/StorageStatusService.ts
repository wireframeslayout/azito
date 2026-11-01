import type { IStorageSettingsRepository } from '../SqliteStorageSettingsRepository';
import type { ResolvedStorageOnboarding } from '../storageOnboarding';
import type { StorageSettings } from './MinioStorageClient';

export type StorageStatus =
  | { status: 'ready' }
  | { status: 'unconfigured'; onboarding: ResolvedStorageOnboarding }
  | { status: 'unreachable'; reason: 'authentication' | 'not_found' | 'timeout' | 'network' | 'unknown'; message: string };

interface StorageProbe { probe(settings: StorageSettings): Promise<void> }

function classifyError(error: unknown): Extract<StorageStatus, { status: 'unreachable' }> {
  const value = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const code = value?.code ?? value?.name;
  const status = value?.$metadata?.httpStatusCode;
  let reason: Extract<StorageStatus, { status: 'unreachable' }>['reason'] = 'unknown';
  if (status === 401 || status === 403 || code === 'AccessDenied' || code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch') reason = 'authentication';
  else if (status === 404 || code === 'NotFound' || code === 'NoSuchBucket') reason = 'not_found';
  else if (code === 'TimeoutError' || code === 'AbortError') reason = 'timeout';
  else if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') reason = 'network';
  return { status: 'unreachable', reason, message: 'Storage is unavailable. Check the connection settings and try again.' };
}

export class StorageStatusService {
  constructor(private readonly settings: IStorageSettingsRepository, private readonly client: StorageProbe, private readonly onboarding: ResolvedStorageOnboarding) {}

  async getStatus(): Promise<StorageStatus> {
    const settings = this.settings.get();
    try {
      await this.client.probe(settings);
    } catch (error) {
      if (!this.settings.isConfigured()) return { status: 'unconfigured', onboarding: this.onboarding };
      return classifyError(error);
    }
    if (!this.settings.isConfigured()) this.settings.markConfigured();
    return { status: 'ready' };
  }
}

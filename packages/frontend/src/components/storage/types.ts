export interface StorageOption {
  type: 'settings' | 'minio' | 'link' | 'managed';
  title: string;
  description: string;
  url?: string;
  endpoint?: string;
  bucket?: string;
}

export interface StorageOnboardingInfo {
  source: 'oss' | 'distribution';
  options: StorageOption[];
}

export type StorageStatus =
  | { state: 'ready' }
  | { state: 'unreachable'; reason: 'dns' | 'refused' | 'timeout' | 'auth' | 'bucket' | 'unknown'; message: string }
  | { state: 'unconfigured'; onboarding: StorageOnboardingInfo };

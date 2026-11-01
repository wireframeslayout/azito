export interface StorageOption {
  id: string;
  kind: 'connect-s3' | 'local-minio' | 'link' | 'managed';
  title: string;
  description: string;
  href?: string;
  defaults?: { endpoint: string; bucket: string };
}

export interface StorageOnboardingInfo {
  source: 'oss' | 'distribution';
  heading: string;
  body: string;
  options: StorageOption[];
  dismissible: boolean;
}

export type StorageStatus =
  | { state: 'ready' }
  | { state: 'unreachable'; reason: 'dns' | 'refused' | 'timeout' | 'auth' | 'bucket' | 'unknown'; message: string }
  | { state: 'unconfigured'; onboarding: StorageOnboardingInfo };

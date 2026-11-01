import type { DistributionInfo, StorageOnboarding } from '../../shared/distributionInfo';

export interface ResolvedStorageOnboarding extends StorageOnboarding {
  source: 'oss' | 'distribution';
}

export function resolveStorageOnboarding(distribution: DistributionInfo | null): ResolvedStorageOnboarding {
  const onboarding = distribution?.storage?.onboarding;
  if (onboarding) return { ...onboarding, source: 'distribution' };
  return { source: 'oss', options: [
    { type: 'settings', title: 'Connect S3-compatible storage', description: 'MinIO, Amazon S3, Cloudflare R2 and more' },
    { type: 'minio', title: 'Run MinIO on this machine', description: 'Show docker compose instructions' },
  ] };
}

import type { DistributionInfo, StorageOnboarding } from '../../shared/distributionInfo';

export interface ResolvedStorageOnboarding extends StorageOnboarding {
  source: 'oss' | 'distribution';
}

export function resolveStorageOnboarding(distribution: DistributionInfo | null): ResolvedStorageOnboarding {
  const onboarding = distribution?.storage?.onboarding;
  if (onboarding) return { ...onboarding, source: 'distribution' };
  return {
    source: 'oss', heading: 'Connect storage', body: 'Store project documents and images and share their paths with your agents.', dismissible: true,
    options: [
      { id: 'connect-s3', kind: 'connect-s3', title: 'Connect S3-compatible storage', description: 'MinIO, Amazon S3, Cloudflare R2 and more' },
      { id: 'local-minio', kind: 'local-minio', title: 'Run MinIO on this machine', description: 'Show docker compose instructions' },
    ],
  };
}

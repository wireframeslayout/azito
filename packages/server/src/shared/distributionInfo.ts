import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { resolveRoot } from './releaseInfo';

const httpUrl = z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'Expected an HTTP(S) URL');
const optionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  kind: z.enum(['connect-s3', 'local-minio', 'link', 'managed']),
  href: httpUrl.optional(),
  defaults: z.object({ endpoint: httpUrl, bucket: z.string().min(1) }).optional(),
}).refine((option) => option.kind !== 'link' || option.href !== undefined, 'A link option requires href')
  .refine((option) => option.kind !== 'managed' || option.defaults !== undefined, 'A managed option requires defaults');
export const distributionInfoSchema = z.object({
  storage: z.object({ onboarding: z.object({
    heading: z.string(), body: z.string(), options: z.array(optionSchema).min(1).refine((options) => new Set(options.map((option) => option.id)).size === options.length, 'Option ids must be unique'), dismissible: z.boolean().default(true),
  }).optional() }).optional(),
});
export type DistributionInfo = z.infer<typeof distributionInfoSchema>;
export type StorageOnboarding = NonNullable<NonNullable<DistributionInfo['storage']>['onboarding']>;

export function readDistributionInfo(filePath: string): DistributionInfo {
  return distributionInfoSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export function getDistributionInfo(basePath: string = resolveRoot()): DistributionInfo | null {
  try {
    return readDistributionInfo(path.join(basePath, 'distribution.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

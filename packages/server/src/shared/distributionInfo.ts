import fs from 'fs';
import path from 'path';
import { z } from 'zod';

const text = z.string().min(1);
const httpUrl = z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'Expected an HTTP(S) URL');
const optionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('settings'), title: text, description: text }).strict(),
  z.object({ type: z.literal('minio'), title: text, description: text }).strict(),
  z.object({ type: z.literal('link'), title: text, description: text, url: httpUrl }).strict(),
  z.object({ type: z.literal('managed'), title: text, description: text, endpoint: httpUrl, bucket: text }).strict(),
]);
export const distributionInfoSchema = z.object({
  storage: z.object({ onboarding: z.object({ options: z.array(optionSchema).min(1) }).strict().optional() }).strict().optional(),
}).strict();
export type DistributionInfo = z.infer<typeof distributionInfoSchema>;
export type StorageOnboarding = NonNullable<NonNullable<DistributionInfo['storage']>['onboarding']>;

export function readDistributionInfo(filePath: string): DistributionInfo {
  return distributionInfoSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export function getDistributionInfo(basePath: string = path.dirname(process.argv[1] || __dirname)): DistributionInfo | null {
  try {
    return readDistributionInfo(path.join(basePath, 'distribution.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

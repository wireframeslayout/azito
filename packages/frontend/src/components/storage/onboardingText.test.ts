import { describe, expect, it } from 'vitest';
import { getOnboardingText, getOptionText } from './onboardingText';
import type { StorageOnboardingInfo } from './types';

const onboarding: StorageOnboardingInfo = {
  source: 'distribution', heading: 'Provider heading', body: 'Provider body', dismissible: false,
  options: [{ id: 'account', kind: 'managed', title: 'Account storage', description: 'Provided storage', defaults: { endpoint: 'https://example.com', bucket: 'files' } }],
};
const translate = (key: string): string => `translated:${key}`;

describe('onboarding text', () => {
  it('preserves distribution text', () => {
    expect(getOnboardingText(onboarding, translate)).toEqual({ heading: 'Provider heading', body: 'Provider body' });
    expect(getOptionText(onboarding, onboarding.options[0], translate)).toEqual({ title: 'Account storage', description: 'Provided storage' });
  });

  it('translates the OSS defaults', () => {
    const oss: StorageOnboardingInfo = { ...onboarding, source: 'oss', options: [{ id: 's3', kind: 'connect-s3', title: 'S3', description: 'S3 storage' }] };
    expect(getOnboardingText(oss, translate).heading).toBe('translated:onboarding.title');
    expect(getOptionText(oss, oss.options[0], translate).title).toBe('translated:onboarding.settings.title');
  });
});

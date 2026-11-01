import type { StorageOnboardingInfo, StorageOption } from './types';

type Translate = (key: string) => string;

export function getOnboardingText(onboarding: StorageOnboardingInfo, t: Translate): { heading: string; body: string } {
  return onboarding.source === 'oss'
    ? { heading: t('onboarding.title'), body: t('onboarding.description') }
    : { heading: onboarding.heading, body: onboarding.body };
}

export function getOptionText(onboarding: StorageOnboardingInfo, option: StorageOption, t: Translate): { title: string; description: string } {
  if (onboarding.source !== 'oss') return { title: option.title, description: option.description };
  const key = option.kind === 'connect-s3' ? 'settings' : 'minio';
  return { title: t(`onboarding.${key}.title`), description: t(`onboarding.${key}.description`) };
}

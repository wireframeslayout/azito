import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { hostFeatureBlockReason, isUnsupportedOsAnswer, describeUnsupportedOs } from './hostFeature';

const t = ((key: string, opts?: Record<string, unknown>) => `${key}${opts ? JSON.stringify(opts) : ''}`) as unknown as TFunction;

describe('hostFeatureBlockReason', () => {
  it('is null on Linux, macOS and an unrecorded host', () => {
    expect(hostFeatureBlockReason({ platform: 'linux' }, 'taskExecution', t)).toBeNull();
    expect(hostFeatureBlockReason({ platform: 'darwin' }, 'files', t)).toBeNull();
    expect(hostFeatureBlockReason(null, 'harness', t)).toBeNull();
  });

  it('says the feature is pending, with its issue, on Windows', () => {
    expect(hostFeatureBlockReason({ platform: 'win32' }, 'taskExecution', t)).toBe('common:hostFeature.windowsPending{"issue":371}');
    expect(hostFeatureBlockReason({ platform: 'win32' }, 'files', t)).toBe('common:hostFeature.windowsPending{"issue":370}');
  });

  it('says tmux is not there at all, not that it is coming', () => {
    expect(hostFeatureBlockReason({ platform: 'win32' }, 'tmux', t)).toBe('common:hostFeature.windowsNoTmux');
  });
});

describe('unsupported_os answers', () => {
  it('recognises the hub answer and keeps its reason', () => {
    const body = { error: 'installing the harness (setup.sh) is a POSIX shell script', code: 'unsupported_os' };
    expect(isUnsupportedOsAnswer(body)).toBe(true);
    expect(describeUnsupportedOs(body, t)).toContain('POSIX shell script');
  });

  it('does not take other answers for it', () => {
    expect(isUnsupportedOsAnswer({ error: 'boom' })).toBe(false);
    expect(isUnsupportedOsAnswer({ error: 'x', code: 'unsupported_host' })).toBe(false);
    expect(isUnsupportedOsAnswer(null)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { pickTaskExecutionServer } from '@azito/shared';
import { hostFeatureBlockReason, isUnsupportedOsAnswer, describeUnsupportedOs, isGitNotFoundAnswer } from './hostFeature';

const t = ((key: string, opts?: Record<string, unknown>) => `${key}${opts ? JSON.stringify(opts) : ''}`) as unknown as TFunction;

describe('hostFeatureBlockReason', () => {
  it('is null on Linux, macOS and an unrecorded host', () => {
    expect(hostFeatureBlockReason({ platform: 'linux' }, 'taskExecution', t)).toBeNull();
    expect(hostFeatureBlockReason({ platform: 'darwin' }, 'workerLaunch', t)).toBeNull();
    expect(hostFeatureBlockReason(null, 'browserRuntime', t)).toBeNull();
  });

  it('says the feature is pending, with its issue, on Windows', () => {
    expect(hostFeatureBlockReason({ platform: 'win32' }, 'taskExecution', t)).toBe('common:hostFeature.windowsPending{"issue":371}');
  });

  it('says tmux is not there at all, not that it is coming', () => {
    expect(hostFeatureBlockReason({ platform: 'win32' }, 'tmux', t)).toBe('common:hostFeature.windowsNoTmux');
  });
});

describe('git_not_found answers', () => {
  it('recognises the hub answer for a Windows host without Git for Windows', () => {
    expect(isGitNotFoundAnswer({ error: 'Git for Windows (git.exe) was not found', code: 'git_not_found' })).toBe(true);
  });

  it('does not take other answers for it', () => {
    expect(isGitNotFoundAnswer({ branches: [] })).toBe(false);
    expect(isGitNotFoundAnswer({ error: 'x', code: 'unsupported_os' })).toBe(false);
    expect(isGitNotFoundAnswer({ code: 'git_not_found' })).toBe(false);
    expect(isGitNotFoundAnswer(null)).toBe(false);
  });
});

describe('unsupported_os answers', () => {
  it('recognises the hub answer and keeps its reason', () => {
    const body = { error: 'installing the browser runtime is a POSIX shell script', code: 'unsupported_os' };
    expect(isUnsupportedOsAnswer(body)).toBe(true);
    expect(describeUnsupportedOs(body, t)).toContain('POSIX shell script');
  });

  it('does not take other answers for it', () => {
    expect(isUnsupportedOsAnswer({ error: 'boom' })).toBe(false);
    expect(isUnsupportedOsAnswer({ error: 'x', code: 'unsupported_host' })).toBe(false);
    expect(isUnsupportedOsAnswer(null)).toBe(false);
  });
});

describe('a task without its own server runs where the project\'s only server is', () => {
  const profiles: Record<string, { platform: 'win32' | 'linux' }> = { win: { platform: 'win32' }, lin: { platform: 'linux' } };
  const reasonFor = (taskServer: string | null, projectServers: string[]): string | null => {
    const server = pickTaskExecutionServer(taskServer, projectServers);
    return server ? hostFeatureBlockReason(profiles[server], 'taskExecution', t) : null;
  };

  it('serverName = null with one Windows server: Execute is closed', () => {
    expect(reasonFor(null, ['win'])).toBe('common:hostFeature.windowsPending{"issue":371}');
  });

  it('serverName = null with one Linux server, or an ambiguous project: not closed here', () => {
    expect(reasonFor(null, ['lin'])).toBeNull();
    expect(reasonFor(null, ['win', 'lin'])).toBeNull();
  });
});

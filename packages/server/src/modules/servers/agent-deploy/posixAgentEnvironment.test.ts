import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { parsePosixAgentEnvironment, POSIX_ENVIRONMENT_COMMAND } from './posixAgentEnvironment';

describe('POSIX login environment', () => {
  it('ignores shell banners and reads the framed result', () => {
    expect(parsePosixAgentEnvironment('banner\nAZITO_ENV_BEGIN\nNODE_VERSION=v24.1.0\nNODE_HOST=darwin arm64\nTMUX=\nTAILSCALE=100.64.0.1\n\nAZITO_ENV_END\nbye')).toEqual({ nodeVersion: 'v24.1.0', nodeHost: 'darwin arm64', tmuxVersion: '', tailscaleIp: '100.64.0.1' });
  });
  it('rejects incomplete and duplicate fields', () => {
    expect(() => parsePosixAgentEnvironment('banner')).toThrow(/Login shell/);
    expect(() => parsePosixAgentEnvironment('AZITO_ENV_BEGIN\nNODE_VERSION=x\nNODE_VERSION=y\nAZITO_ENV_END\n')).toThrow(/duplicate/);
    expect(() => parsePosixAgentEnvironment('AZITO_ENV_BEGIN\nNODE_VERSION=x\nAZITO_ENV_END\n')).toThrow(/NODE_HOST/);
  });
  it.skipIf(process.platform === 'win32')('runs the probe through a real login shell with a parseable result', () => {
    const output = execFileSync('/bin/sh', ['-c', POSIX_ENVIRONMENT_COMMAND], { env: { ...process.env, SHELL: '/bin/bash' }, encoding: 'utf8', timeout: 5000 });
    const result = parsePosixAgentEnvironment(output);
    expect(result.nodeVersion).toMatch(/^v\d+/);
    expect(result.nodeHost).toBe(`${process.platform} ${process.arch}`);
  });
});

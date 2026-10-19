import { describe, it, expect } from 'vitest';
import { parseHarnessCheck, buildHarnessCheckCommand } from './installStatusParsers';

describe('parseHarnessCheck', () => {
  it('returns installed: false when directory is missing', () => {
    const result = parseHarnessCheck('', 'abc123');
    expect(result.installed).toBe(false);
    expect(result.outdated).toBeUndefined();
  });

  it('returns installed: true without outdated when no expectedHash is given', () => {
    const result = parseHarnessCheck('/home/user/.azito/harness-dev/skills\n');
    expect(result.installed).toBe(true);
    expect(result.outdated).toBeUndefined();
  });

  it('returns outdated: false when VERSION matches', () => {
    const result = parseHarnessCheck('/home/user/.azito/harness-dev/skills\nabc123\n', 'abc123');
    expect(result.installed).toBe(true);
    expect(result.outdated).toBe(false);
    expect(result.installedVersion).toBe('abc123');
    expect(result.expectedVersion).toBe('abc123');
  });

  it('returns outdated: true when VERSION differs', () => {
    const result = parseHarnessCheck('/home/user/.azito/harness-dev/skills\nold-version\n', 'abc123');
    expect(result.installed).toBe(true);
    expect(result.outdated).toBe(true);
    expect(result.installedVersion).toBe('old-version');
    expect(result.expectedVersion).toBe('abc123');
  });

  it('returns outdated: true when VERSION file is missing', () => {
    const result = parseHarnessCheck('/home/user/.azito/harness-dev/skills\n', 'abc123');
    expect(result.installed).toBe(true);
    expect(result.outdated).toBe(true);
    expect(result.installedVersion).toBeUndefined();
    expect(result.expectedVersion).toBe('abc123');
  });

  it('includes autoUpdate result when provided', () => {
    const autoUpdate = { status: 'error', message: 'SSH failed', at: '2026-10-19T00:00:00Z' };
    const result = parseHarnessCheck('/home/user/.azito/harness-dev/skills\nold\n', 'new', autoUpdate);
    expect(result.autoUpdate).toEqual(autoUpdate);
  });

  it('does not include autoUpdate when not provided', () => {
    const result = parseHarnessCheck('/home/user/.azito/harness-dev/skills\n', 'abc');
    expect(result.autoUpdate).toBeUndefined();
  });
});

describe('buildHarnessCheckCommand', () => {
  it('includes VERSION cat in the command', () => {
    const cmd = buildHarnessCheckCommand('dev');
    expect(cmd).toContain('cat ~/.azito/harness-dev/VERSION');
  });

  it('uses default path without prefix', () => {
    const cmd = buildHarnessCheckCommand();
    expect(cmd).toContain('~/.azito/harness/VERSION');
    expect(cmd).toContain('~/.azito/harness/skills');
  });
});

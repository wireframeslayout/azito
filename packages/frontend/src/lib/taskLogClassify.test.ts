import { describe, it, expect } from 'vitest';
import { classify } from '../lib/taskLogClassify';

describe('classify', () => {
  it('shows a skipped resource check as its own entry, not as a bare system line', () => {
    expect(classify('command', { type: 'resource_guard_skipped', reason: 'unreachable' })).toBe('resource-skipped');
  });

  it('keeps other command entries as before', () => {
    expect(classify('command', { type: 'worker_launch', command: 'claude' })).toBe('launch');
    expect(classify('command', { type: 'resource_guard_blocked' })).toBe('system');
  });
});

describe('resource check skipped sentence', () => {
  it('exists in ja and en', async () => {
    const ja = (await import('../i18n/locales/ja/tasks.json')).default.log;
    const en = (await import('../i18n/locales/en/tasks.json')).default.log;
    expect(ja.resourceGuardSkipped).toContain('{{reason}}');
    expect(en.resourceGuardSkipped).toContain('{{reason}}');
  });
});

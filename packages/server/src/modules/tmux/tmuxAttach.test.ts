import { describe, it, expect } from 'vitest';
import { buildTmuxAttachPlan } from './tmuxAttach';

describe('buildTmuxAttachPlan', () => {
  const plan = buildTmuxAttachPlan('mysess', '3', '_azito_mysess_1_123', 'http://localhost:3001');

  it('prepare verifies the window exists', () => {
    expect(plan.prepare[0]).toEqual(['list-panes', '-t', 'mysess:3']);
  });

  it('prepare enables clipboard', () => {
    expect(plan.prepare[1]).toEqual(['set-option', '-s', 'set-clipboard', 'on']);
  });

  it('prepare creates a linked session with AZITO_URL', () => {
    expect(plan.prepare[2]).toEqual([
      'new-session', '-d', '-t', 'mysess', '-s', '_azito_mysess_1_123',
      '-e', 'AZITO_URL=http://localhost:3001',
    ]);
  });

  it('prepare hides status bar and selects window', () => {
    expect(plan.prepare[3]).toEqual(['set-option', '-t', '_azito_mysess_1_123', 'status', 'off']);
    expect(plan.prepare[4]).toEqual(['select-window', '-t', '_azito_mysess_1_123:3']);
  });

  it('attach targets the linked session', () => {
    expect(plan.attach).toEqual(['attach-session', '-t', '_azito_mysess_1_123']);
  });

  it('fallbackAttach targets the original window directly', () => {
    expect(plan.fallbackAttach).toEqual(['attach-session', '-t', 'mysess:3']);
  });

  it('cleanup kills the linked session', () => {
    expect(plan.cleanup).toEqual(['kill-session', '-t', '_azito_mysess_1_123']);
  });
});

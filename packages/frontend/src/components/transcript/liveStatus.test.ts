import { describe, expect, it } from 'vitest';
import { deriveLiveStatus } from './liveStatus';
import type { TranscriptEntry } from './transcriptTypes';

const NOW = new Date('2026-08-09T12:00:00.000Z').getTime();

function entry(overrides: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    uuid: 'u1',
    type: 'user',
    timestamp: new Date(NOW).toISOString(),
    blocks: [],
    ...overrides,
  };
}

describe('deriveLiveStatus', () => {
  it('returns null when there are no entries', () => {
    expect(deriveLiveStatus([], NOW)).toBeNull();
  });

  it('returns null when the last entry has no timestamp', () => {
    const entries = [entry({ timestamp: null })];
    expect(deriveLiveStatus(entries, NOW)).toBeNull();
  });

  it('returns null when the last entry timestamp is invalid', () => {
    const entries = [entry({ timestamp: 'not-a-date' })];
    expect(deriveLiveStatus(entries, NOW)).toBeNull();
  });

  it('returns null when the last entry is older than 90 seconds', () => {
    const entries = [entry({ timestamp: new Date(NOW - 91_000).toISOString() })];
    expect(deriveLiveStatus(entries, NOW)).toBeNull();
  });

  it('still shows a status exactly at the 90 second boundary', () => {
    const entries = [entry({ type: 'user', timestamp: new Date(NOW - 90_000).toISOString() })];
    expect(deriveLiveStatus(entries, NOW)).toEqual({ kind: 'thinking' });
  });

  it('tolerates a small future timestamp within clock skew', () => {
    const entries = [entry({ type: 'user', timestamp: new Date(NOW + 3_000).toISOString() })];
    expect(deriveLiveStatus(entries, NOW)).toEqual({ kind: 'thinking' });
  });

  it('returns null when the timestamp is far in the future (beyond clock skew tolerance)', () => {
    const entries = [entry({ type: 'user', timestamp: new Date(NOW + 6_000).toISOString() })];
    expect(deriveLiveStatus(entries, NOW)).toBeNull();
  });

  it('returns thinking when the last entry is from the user', () => {
    const entries = [entry({ type: 'user' })];
    expect(deriveLiveStatus(entries, NOW)).toEqual({ kind: 'thinking' });
  });

  it('returns thinking when the last entry is a tool result', () => {
    const entries = [entry({ type: 'tool', blocks: [{ kind: 'tool_result', text: 'ok', truncated: false }] })];
    expect(deriveLiveStatus(entries, NOW)).toEqual({ kind: 'thinking' });
  });

  it('returns tool with the tool name when the assistant is mid tool_use', () => {
    const entries = [
      entry({
        type: 'assistant',
        blocks: [
          { kind: 'text', text: 'checking...' },
          { kind: 'tool_use', name: 'Bash', input: '{}', truncated: false },
        ],
      }),
    ];
    expect(deriveLiveStatus(entries, NOW)).toEqual({ kind: 'tool', toolName: 'Bash' });
  });

  it('returns null when the assistant finished with a text block', () => {
    const entries = [entry({ type: 'assistant', blocks: [{ kind: 'text', text: 'done' }] })];
    expect(deriveLiveStatus(entries, NOW)).toBeNull();
  });

  it('returns null when the assistant finished with a thinking block', () => {
    const entries = [entry({ type: 'assistant', blocks: [{ kind: 'thinking', text: 'pondering' }] })];
    expect(deriveLiveStatus(entries, NOW)).toBeNull();
  });

  it('returns null when the assistant entry has no blocks', () => {
    const entries = [entry({ type: 'assistant', blocks: [] })];
    expect(deriveLiveStatus(entries, NOW)).toBeNull();
  });

  it('returns null for system and other entries', () => {
    expect(deriveLiveStatus([entry({ type: 'system' })], NOW)).toBeNull();
    expect(deriveLiveStatus([entry({ type: 'other' })], NOW)).toBeNull();
  });

  it('returns null when the last entry is interrupted (stops the counter immediately)', () => {
    expect(deriveLiveStatus([entry({ type: 'interrupted', blocks: [] })], NOW)).toBeNull();
  });

  it('only looks at the last entry, ignoring earlier ones', () => {
    const entries = [
      entry({ uuid: 'u1', type: 'assistant', blocks: [{ kind: 'tool_use', name: 'Bash', input: '{}', truncated: false }] }),
      entry({ uuid: 'u2', type: 'user' }),
    ];
    expect(deriveLiveStatus(entries, NOW)).toEqual({ kind: 'thinking' });
  });
});

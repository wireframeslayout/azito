import { describe, it, expect } from 'vitest';
import { AGENT_TRANSCRIPT_PROFILES, getAgentTranscriptProfile } from './profiles';

describe('AGENT_TRANSCRIPT_PROFILES / interactionSignal', () => {
  it('marks claude as hook-capable (Notification hook drives real-time pending-answer detection)', () => {
    expect(getAgentTranscriptProfile('claude')?.interactionSignal).toBe('hook');
  });

  it('marks codex as having no interaction signal', () => {
    expect(getAgentTranscriptProfile('codex')?.interactionSignal).toBe('none');
  });

  it('every profile declares a valid interactionSignal', () => {
    for (const profile of AGENT_TRANSCRIPT_PROFILES) {
      expect(['hook', 'none']).toContain(profile.interactionSignal);
    }
  });
});

import { describe, it, expect, vi } from 'vitest';
import { PaneClassifier } from './PaneClassifier';
import type { CodexExecClient } from './CodexExecClient';

function createMockCodexClient(response: string): CodexExecClient {
  return { exec: vi.fn().mockResolvedValue(response) } as unknown as CodexExecClient;
}

describe('PaneClassifier', () => {
  describe('programmatic classification', () => {
    it('should detect PHASE_COMPLETE when count exceeds baseline', async () => {
      const client = createMockCodexClient('{}');
      const classifier = new PaneClassifier(client);
      const pane = 'some output\nPHASE_COMPLETE\nmore output\nPHASE_COMPLETE';
      const result = await classifier.classify(pane, { phaseComplete: 1, question: 0 });
      expect(result.status).toBe('phase_complete');
    });

    it('should NOT detect PHASE_COMPLETE when count equals baseline', async () => {
      const client = createMockCodexClient('{"status":"still_working"}');
      const classifier = new PaneClassifier(client);
      const pane = 'some output\nPHASE_COMPLETE';
      const result = await classifier.classify(pane, { phaseComplete: 1, question: 0 });
      expect(result.status).toBe('still_working');
    });

    it('should detect QUESTION: when count exceeds baseline', async () => {
      const client = createMockCodexClient('{"status":"question","questions":[{"text":"What color?","type":"select","options":["red","blue"]}]}');
      const classifier = new PaneClassifier(client);
      const pane = 'QUESTION: old\nQUESTION: What color do you want?';
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 1 });
      expect(result.status).toBe('question');
    });

    it('should detect interactive prompt patterns', async () => {
      const client = createMockCodexClient('{"status":"question","questions":[{"text":"Pick one","type":"select","options":["A","B"]}]}');
      const classifier = new PaneClassifier(client);
      const pane = 'Pick one:\n❯ 1. Option A\n  2. Option B\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel';
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });
      expect(result.status).toBe('question');
    });

    it('should fallback to text extraction when LLM returns no questions', async () => {
      const client = createMockCodexClient('{"status":"question","questions":[]}');
      const classifier = new PaneClassifier(client);
      const pane = 'QUESTION: What framework should we use?\nQUESTION: old template';
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 1 });
      expect(result.status).toBe('question');
      expect(result.questions).toBeDefined();
      expect(result.questions!.length).toBeGreaterThan(0);
      expect(result.questions![0].text).toContain('What framework should we use');
    });
  });

  describe('QUESTIONS_JSON structured detection', () => {
    it('should NOT detect template example QUESTIONS_JSON', async () => {
      const client = createMockCodexClient('{"status":"still_working"}');
      const classifier = new PaneClassifier(client);
      const pane = 'QUESTIONS_JSON: [{"text":"question text","type":"select","options":["option1","option2"]},{"text":"open question","type":"text"}]';
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });
      expect(result.status).toBe('still_working');
    });

    it('should detect and parse QUESTIONS_JSON from pane output', async () => {
      const client = createMockCodexClient('{}');
      const classifier = new PaneClassifier(client);
      const pane = 'thinking...\nQUESTIONS_JSON: [{"text":"Pick color","type":"select","options":["red","blue"]}]\nwaiting...';
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });
      expect(result.status).toBe('question');
      expect(result.questions).toHaveLength(1);
      expect(result.questions![0].text).toBe('Pick color');
      expect(result.questions![0].options).toEqual(['red', 'blue']);
      expect(client.exec).not.toHaveBeenCalled();
    });

    it('should handle QUESTIONS_JSON with multiple questions', async () => {
      const client = createMockCodexClient('{}');
      const classifier = new PaneClassifier(client);
      const pane = 'QUESTIONS_JSON: [{"text":"Q1","type":"select","options":["A","B"]},{"text":"Q2","type":"text"}]';
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });
      expect(result.questions).toHaveLength(2);
      expect(result.questions![1].type).toBe('text');
    });

    it('should prioritize PHASE_COMPLETE over QUESTIONS_JSON', async () => {
      const client = createMockCodexClient('{}');
      const classifier = new PaneClassifier(client);
      const pane = 'plan output\nPHASE_COMPLETE\nQUESTIONS_JSON: [{"text":"extra","type":"text"}]';
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });
      expect(result.status).toBe('phase_complete');
    });
  });

  describe('PHASE_COMPLETE vs QUESTION priority', () => {
    it('should prioritize PHASE_COMPLETE when both markers present', async () => {
      const client = createMockCodexClient('{}');
      const classifier = new PaneClassifier(client);
      const pane = 'plan content\nPHASE_COMPLETE\nQUESTION: additional question';
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });
      // PaneClassifier checks PHASE_COMPLETE first
      expect(result.status).toBe('phase_complete');
    });
  });

  describe('prompt not yet processed detection', () => {
    it('should return still_working when </output> tag is visible in tail', async () => {
      const client = createMockCodexClient('{"status":"phase_complete"}');
      const classifier = new PaneClassifier(client);
      const pane = 'some prompt template content\n</output>\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });
      expect(result.status).toBe('still_working');
      expect(client.exec).not.toHaveBeenCalled();
    });

    it('should NOT early-return still_working when only bypass permissions is visible (no </output>)', async () => {
      const client = createMockCodexClient('{"status":"still_working"}');
      const classifier = new PaneClassifier(client);
      const pane = 'pasted prompt\nbypass permissions on (shift+tab to cycle)';
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });
      // No </output> tag: must fall through to LLM classification
      expect(client.exec).toHaveBeenCalled();
      expect(result.status).toBe('still_working');
    });
  });

  describe('startup banner guard', () => {
    it('should return still_working when pane shows only startup banner', async () => {
      const client = createMockCodexClient('{"status":"phase_complete"}');
      const classifier = new PaneClassifier(client);
      const pane = [
        '╭─ Claude Code ─╮',
        '│ /help         │',
        '╰──────────────╯',
        'Tips: Run /help for available commands',
      ].join('\n');

      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });

      expect(result.status).toBe('still_working');
      expect(client.exec).not.toHaveBeenCalled();
    });

    it('should NOT guard when startup banner has thinking indicators', async () => {
      const client = createMockCodexClient('{"status":"still_working"}');
      const classifier = new PaneClassifier(client);
      const pane = [
        '╭─ Claude Code ─╮',
        '│ /help         │',
        '╰──────────────╯',
        'Tips: Run /help for available commands',
        'Thinking...',
      ].join('\n');

      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });

      expect(result.status).toBe('still_working');
      expect(client.exec).toHaveBeenCalled();
    });

    it('should NOT guard when content exceeds 30 non-blank lines', async () => {
      const client = createMockCodexClient('{"status":"still_working"}');
      const classifier = new PaneClassifier(client);
      const pane = [
        '╭─ Claude Code ─╮',
        '│ /help         │',
        '╰──────────────╯',
        'Tips: Run /help for available commands',
        ...Array.from({ length: 31 }, (_, i) => `line ${i + 1}`),
      ].join('\n');

      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });

      expect(result.status).toBe('still_working');
      expect(client.exec).toHaveBeenCalled();
    });
  });

  describe('doneMarker detection', () => {
    it('should return phase_complete when pane contains done marker as agent output with ⏺ prefix', async () => {
      const client = createMockCodexClient('{"status":"still_working"}');
      const classifier = new PaneClassifier(client);
      const marker = 'AZITO_DONE_15_abc123';
      // Status bar present but completion marker also present as agent output
      const pane = [
        'Agent is working...',
        '⏺ ' + marker,
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ].join('\n');
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 }, marker);
      expect(result.status).toBe('phase_complete');
      expect(client.exec).not.toHaveBeenCalled();
    });

    it('should return phase_complete when done marker appears on a line by itself', async () => {
      const client = createMockCodexClient('{"status":"still_working"}');
      const classifier = new PaneClassifier(client);
      const marker = 'AZITO_DONE_7_xyz';
      const pane = ['Task complete.', marker, ''].join('\n');
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 }, marker);
      expect(result.status).toBe('phase_complete');
      expect(client.exec).not.toHaveBeenCalled();
    });

    it('should NOT return phase_complete when marker only appears in instruction echo', async () => {
      const client = createMockCodexClient('{"status":"still_working"}');
      const classifier = new PaneClassifier(client);
      const marker = 'AZITO_DONE_1_x';
      // Marker present only as part of the instruction text, not as standalone output
      const pane = `Report "${marker}" when done.\nAgent is still thinking...`;
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 }, marker);
      // Instruction echo line has surrounding text so regex won't match; falls through to LLM
      expect(client.exec).toHaveBeenCalled();
      expect(result.status).toBe('still_working');
    });

    it('should pass doneMarker hint to LLM prompt', async () => {
      const client = createMockCodexClient('{"status":"still_working"}');
      const classifier = new PaneClassifier(client);
      const marker = 'AZITO_DONE_99_hint';
      const pane = 'Agent is thinking...';
      await classifier.classify(pane, { phaseComplete: 0, question: 0 }, marker);
      expect(client.exec).toHaveBeenCalled();
      const promptArg = (client.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(promptArg).toContain(marker);
    });
  });

  describe('startup banner guard', () => {
    it('should return still_working when pane shows only startup banner', async () => {
      const client = createMockCodexClient('{"status":"phase_complete"}');
      const classifier = new PaneClassifier(client);
      const pane = [
        '╭─ Claude Code ─╮',
        '│   /help       │',
        '╰───────────────╯',
        'Tips: Use /help for commands',
        '',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ].join('\n');
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });
      expect(result.status).toBe('still_working');
      expect(client.exec).not.toHaveBeenCalled();
    });

    it('should NOT guard when startup banner has thinking indicators', async () => {
      const client = createMockCodexClient('{"status":"still_working"}');
      const classifier = new PaneClassifier(client);
      const pane = [
        '╭─ Claude Code ─╮',
        '│   /help       │',
        '╰───────────────╯',
        'Thinking...',
      ].join('\n');
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });
      // Falls through to normal classification (guard did NOT trigger)
      expect(client.exec).toHaveBeenCalled();
    });

    it('should NOT guard when content exceeds 30 non-blank lines', async () => {
      const client = createMockCodexClient('{"status":"still_working"}');
      const classifier = new PaneClassifier(client);
      const lines = ['Claude Code', '/help'];
      for (let i = 0; i < 30; i++) lines.push(`line ${i}`);
      const result = await classifier.classify(lines.join('\n'), { phaseComplete: 0, question: 0 });
      expect(client.exec).toHaveBeenCalled();
    });
  });

  describe('LLM fallback', () => {
    it('should call LLM when no programmatic match', async () => {
      const client = createMockCodexClient('{"status":"still_working"}');
      const classifier = new PaneClassifier(client);
      const pane = 'Agent is thinking...\nSpinner animation';
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });
      expect(result.status).toBe('still_working');
      expect(client.exec).toHaveBeenCalled();
    });

    it('should return still_working on LLM error', async () => {
      const client = { exec: vi.fn().mockRejectedValue(new Error('timeout')) } as unknown as CodexExecClient;
      const classifier = new PaneClassifier(client);
      const pane = 'some output';
      const result = await classifier.classify(pane, { phaseComplete: 0, question: 0 });
      expect(result.status).toBe('still_working');
    });
  });
});

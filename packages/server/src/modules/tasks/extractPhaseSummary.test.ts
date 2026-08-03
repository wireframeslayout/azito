import { describe, it, expect } from 'vitest';
import { extractPhaseSummary } from './extractPhaseSummary';

describe('extractPhaseSummary', () => {
  const validJson = '{"phase":"planning","status":"completed","summary":"Created plan","tokensUsed":{"input":12000,"output":3500},"durationSeconds":45}';

  it('extracts valid summary from output', () => {
    const output = `Here is the plan output.\n\nAZITO_PHASE_SUMMARY: ${validJson}`;
    const { cleanOutput, summary } = extractPhaseSummary(output);
    expect(cleanOutput).toBe('Here is the plan output.');
    expect(summary).toEqual(JSON.parse(validJson));
  });

  it('returns null summary when no marker present', () => {
    const output = 'Just regular output without any marker.';
    const { cleanOutput, summary } = extractPhaseSummary(output);
    expect(cleanOutput).toBe(output);
    expect(summary).toBeNull();
  });

  it('handles trailing newlines after JSON', () => {
    const output = `Output content\n\nAZITO_PHASE_SUMMARY: ${validJson}\n\n`;
    const { cleanOutput, summary } = extractPhaseSummary(output);
    expect(cleanOutput).toBe('Output content');
    expect(summary).not.toBeNull();
    expect(summary!.phase).toBe('planning');
  });

  it('handles trailing content after JSON line (pipe-pane fallback)', () => {
    const output = `Output content\nAZITO_PHASE_SUMMARY: ${validJson}\nAZITO_EOF\n$ echo "AZITO_DONE_42_abc"`;
    const { cleanOutput, summary } = extractPhaseSummary(output);
    expect(cleanOutput).toBe('Output content');
    expect(summary).not.toBeNull();
    expect(summary!.phase).toBe('planning');
  });

  it('returns null summary for invalid JSON', () => {
    const output = 'Output\nAZITO_PHASE_SUMMARY: {not valid json}';
    const { cleanOutput, summary } = extractPhaseSummary(output);
    expect(cleanOutput).toBe('Output');
    expect(summary).toBeNull();
  });

  it('returns null summary for non-object JSON', () => {
    const output = 'Output\nAZITO_PHASE_SUMMARY: "just a string"';
    const { cleanOutput, summary } = extractPhaseSummary(output);
    expect(cleanOutput).toBe('Output');
    expect(summary).toBeNull();
  });

  it('returns null summary when marker has no content after it', () => {
    const output = 'Output\nAZITO_PHASE_SUMMARY:\n';
    const { cleanOutput, summary } = extractPhaseSummary(output);
    expect(cleanOutput).toBe('Output');
    expect(summary).toBeNull();
  });

  it('uses the last occurrence when marker appears multiple times', () => {
    const firstJson = '{"phase":"planning","status":"completed","summary":"First"}';
    const secondJson = '{"phase":"implementing","status":"completed","summary":"Second"}';
    const output = `Part 1\nAZITO_PHASE_SUMMARY: ${firstJson}\nPart 2\nAZITO_PHASE_SUMMARY: ${secondJson}`;
    const { cleanOutput, summary } = extractPhaseSummary(output);
    expect(cleanOutput).toBe(`Part 1\nAZITO_PHASE_SUMMARY: ${firstJson}\nPart 2`);
    expect(summary!.phase).toBe('implementing');
  });

  it('trims whitespace from clean output', () => {
    const output = `Output with trailing spaces   \n\n\nAZITO_PHASE_SUMMARY: ${validJson}`;
    const { cleanOutput } = extractPhaseSummary(output);
    expect(cleanOutput).toBe('Output with trailing spaces');
  });

  it('handles empty output before marker', () => {
    const output = `AZITO_PHASE_SUMMARY: ${validJson}`;
    const { cleanOutput, summary } = extractPhaseSummary(output);
    expect(cleanOutput).toBe('');
    expect(summary).not.toBeNull();
  });
});

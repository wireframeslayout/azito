import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { collectCodexUsage } from './UsageCollector';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-test-'));
}

describe('collectCodexUsage', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null when directory does not exist', () => {
    expect(collectCodexUsage('/nonexistent-path-xyz')).toBeNull();
  });

  it('returns null when directory is empty', () => {
    expect(collectCodexUsage(dir)).toBeNull();
  });

  it('uses the last token_count total_token_usage per file', () => {
    const lines = [
      JSON.stringify({
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 70 },
            last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      }),
      JSON.stringify({
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 140 },
            last_token_usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
          },
        },
      }),
    ].join('\n');

    fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), lines);

    const result = collectCodexUsage(dir);
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(100);
    expect(result!.cachedInputTokens).toBe(30);
    expect(result!.outputTokens).toBe(40);
    expect(result!.reasoningOutputTokens).toBe(10);
    expect(result!.totalTokens).toBe(140);
  });

  it('sums across multiple files', () => {
    const makeFile = (input: number, output: number) => JSON.stringify({
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } },
      },
    });

    fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), makeFile(100, 50));
    fs.writeFileSync(path.join(dir, 'rollout-b.jsonl'), makeFile(200, 80));

    const result = collectCodexUsage(dir);
    expect(result!.inputTokens).toBe(300);
    expect(result!.outputTokens).toBe(130);
    expect(result!.totalTokens).toBe(430);
  });

  it('ignores last_token_usage (only uses total_token_usage)', () => {
    const lines = JSON.stringify({
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
          last_token_usage: { input_tokens: 9999, output_tokens: 9999, total_tokens: 19998 },
        },
      },
    });

    fs.writeFileSync(path.join(dir, 'rollout.jsonl'), lines);

    const result = collectCodexUsage(dir);
    expect(result!.inputTokens).toBe(100);
    expect(result!.totalTokens).toBe(140);
  });

  it('returns null when no token_count events exist', () => {
    fs.writeFileSync(path.join(dir, 'rollout.jsonl'), JSON.stringify({ payload: { type: 'other' } }));
    expect(collectCodexUsage(dir)).toBeNull();
  });

  it('extracts rate_limits from the latest file', () => {
    const content = JSON.stringify({
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
          rate_limits: { primary: { used_percent: 42.5 }, plan_type: 'pro' },
        },
      },
    });

    fs.writeFileSync(path.join(dir, 'rollout-z.jsonl'), content);

    const result = collectCodexUsage(dir);
    expect(result!.rateLimits?.primary?.usedPercent).toBe(42.5);
    expect(result!.rateLimits?.planType).toBe('pro');
  });
});

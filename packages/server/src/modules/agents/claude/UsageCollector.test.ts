import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { collectClaudeUsage } from './UsageCollector';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-test-'));
}

describe('collectClaudeUsage', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null when directory does not exist', () => {
    expect(collectClaudeUsage('/nonexistent-path-xyz')).toBeNull();
  });

  it('returns null when directory is empty', () => {
    expect(collectClaudeUsage(dir)).toBeNull();
  });

  it('collects usage from assistant messages', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_001', model: 'claude-sonnet-4-5',
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_002', model: 'claude-opus-4-6',
          usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 30, cache_creation_input_tokens: 15 },
        },
      }),
    ].join('\n');

    fs.writeFileSync(path.join(dir, 'session.jsonl'), lines);

    const result = collectClaudeUsage(dir);
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(300);
    expect(result!.outputTokens).toBe(130);
    expect(result!.cacheReadTokens).toBe(50);
    expect(result!.cacheCreationTokens).toBe(25);
    expect(result!.totalTokens).toBe(430);
    expect(Object.keys(result!.byModel)).toHaveLength(2);
    expect(result!.byModel['claude-sonnet-4-5'].inputTokens).toBe(100);
    expect(result!.byModel['claude-opus-4-6'].inputTokens).toBe(200);
  });

  it('deduplicates by message.id', () => {
    const msg = {
      type: 'assistant',
      message: {
        id: 'msg_dup', model: 'claude-sonnet-4-5',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };
    const lines = [JSON.stringify(msg), JSON.stringify(msg)].join('\n');

    fs.writeFileSync(path.join(dir, 'a.jsonl'), lines);

    const result = collectClaudeUsage(dir);
    expect(result!.inputTokens).toBe(100);
    expect(result!.totalTokens).toBe(150);
  });

  it('deduplicates across files', () => {
    const msg = {
      type: 'assistant',
      message: {
        id: 'msg_cross', model: 'claude-sonnet-4-5',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };

    fs.writeFileSync(path.join(dir, 'a.jsonl'), JSON.stringify(msg));
    fs.writeFileSync(path.join(dir, 'b.jsonl'), JSON.stringify(msg));

    const result = collectClaudeUsage(dir);
    expect(result!.inputTokens).toBe(100);
  });

  it('skips lines with missing usage', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { id: 'msg_no_usage', model: 'test' } }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_ok', model: 'test', usage: { input_tokens: 10, output_tokens: 5 } },
      }),
    ].join('\n');

    fs.writeFileSync(path.join(dir, 'session.jsonl'), lines);

    const result = collectClaudeUsage(dir);
    expect(result!.inputTokens).toBe(10);
    expect(result!.totalTokens).toBe(15);
  });

  it('returns null when files exist but contain no assistant usage', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'mode', mode: 'normal' }),
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'session.jsonl'), lines);

    expect(collectClaudeUsage(dir)).toBeNull();
  });

  it('walks subdirectories', () => {
    const subdir = path.join(dir, 'project-a');
    fs.mkdirSync(subdir);
    fs.writeFileSync(
      path.join(subdir, 'session.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_sub', model: 'test', usage: { input_tokens: 42, output_tokens: 8 } },
      }),
    );

    const result = collectClaudeUsage(dir);
    expect(result!.inputTokens).toBe(42);
  });
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { TokenUsage } from '../AgentProvider';
import { findJsonlFiles } from '../findJsonlFiles';

export interface ClaudeModelUsage extends TokenUsage {
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ClaudeUsage extends ClaudeModelUsage {
  byModel: Record<string, ClaudeModelUsage>;
}

function emptyModelUsage(): ClaudeModelUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 };
}

export function collectClaudeUsage(baseDir?: string): ClaudeUsage | null {
  const dir = baseDir ?? path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');

  if (!fs.existsSync(dir)) return null;

  const files = findJsonlFiles(dir);
  if (files.length === 0) return null;

  const seenIds = new Set<string>();
  const total = emptyModelUsage();
  const byModel: Record<string, ClaudeModelUsage> = {};
  let hasData = false;

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      if (!line) continue;

      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const rec = record as Record<string, unknown>;
      if (rec.type !== 'assistant') continue;

      const msg = rec.message as Record<string, unknown> | undefined;
      if (!msg?.usage || !msg.id) continue;

      const msgId = msg.id as string;
      if (seenIds.has(msgId)) continue;
      seenIds.add(msgId);
      hasData = true;

      const usage = msg.usage as Record<string, number>;
      const input = usage.input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheCreation = usage.cache_creation_input_tokens ?? 0;

      total.inputTokens += input;
      total.outputTokens += output;
      total.cacheReadTokens += cacheRead;
      total.cacheCreationTokens += cacheCreation;
      total.totalTokens += input + output;

      const model = (msg.model as string) ?? 'unknown';
      if (!byModel[model]) byModel[model] = emptyModelUsage();
      byModel[model].inputTokens += input;
      byModel[model].outputTokens += output;
      byModel[model].cacheReadTokens += cacheRead;
      byModel[model].cacheCreationTokens += cacheCreation;
      byModel[model].totalTokens += input + output;
    }
  }

  if (!hasData) return null;

  return { ...total, byModel };
}

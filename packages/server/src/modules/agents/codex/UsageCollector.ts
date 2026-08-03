import fs from 'fs';
import path from 'path';
import os from 'os';
import type { TokenUsage } from '../AgentProvider';
import { findJsonlFiles } from '../findJsonlFiles';

export interface CodexRateLimits {
  primary?: { usedPercent: number };
  secondary?: { usedPercent: number };
  planType?: string;
}

export interface CodexUsage extends TokenUsage {
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  rateLimits?: CodexRateLimits;
}

interface TokenCountInfo {
  total_token_usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
    total_tokens?: number;
  };
  rate_limits?: {
    primary?: { used_percent?: number };
    secondary?: { used_percent?: number };
    plan_type?: string;
  };
}

function extractLastTokenCount(filePath: string): { usage: TokenCountInfo['total_token_usage']; rateLimits: TokenCountInfo['rate_limits'] } | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  let lastUsage: TokenCountInfo['total_token_usage'] | undefined;
  let lastRateLimits: TokenCountInfo['rate_limits'] | undefined;

  for (const line of lines) {
    if (!line) continue;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const rec = record as Record<string, unknown>;
    const payload = rec.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== 'token_count') continue;

    const info = payload.info as TokenCountInfo | undefined;
    if (!info?.total_token_usage) continue;

    lastUsage = info.total_token_usage;
    if (info.rate_limits) lastRateLimits = info.rate_limits;
  }

  if (!lastUsage) return null;
  return { usage: lastUsage, rateLimits: lastRateLimits };
}

export function collectCodexUsage(baseDir?: string): CodexUsage | null {
  const dir = baseDir ?? path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');

  if (!fs.existsSync(dir)) return null;

  const files = findJsonlFiles(dir);
  if (files.length === 0) return null;

  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let totalTokens = 0;
  let latestRateLimits: CodexRateLimits | undefined;
  let latestFile = '';
  let hasData = false;

  for (const file of files) {
    const result = extractLastTokenCount(file);
    if (!result?.usage) continue;

    hasData = true;
    const u = result.usage;
    inputTokens += u.input_tokens ?? 0;
    cachedInputTokens += u.cached_input_tokens ?? 0;
    outputTokens += u.output_tokens ?? 0;
    reasoningOutputTokens += u.reasoning_output_tokens ?? 0;
    totalTokens += u.total_tokens ?? 0;

    if (file > latestFile) {
      latestFile = file;
      if (result.rateLimits) {
        latestRateLimits = {
          primary: result.rateLimits.primary ? { usedPercent: result.rateLimits.primary.used_percent ?? 0 } : undefined,
          secondary: result.rateLimits.secondary ? { usedPercent: result.rateLimits.secondary.used_percent ?? 0 } : undefined,
          planType: result.rateLimits.plan_type,
        };
      }
    }
  }

  if (!hasData) return null;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    rateLimits: latestRateLimits,
  };
}

import { ProviderType } from './Provider';
import { listAgentDefinitions, getAgentModels, getAgentTypes } from '../agents/registry';

// ─── Types ───

export interface ModelEntry {
  id: string;
  label: string;
}

export interface LlmCallOptions {
  maxTokens?: number;
  temperature?: number;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  content: string;
  usage: Record<string, unknown>;
}

export interface ProviderConfig {
  type: ProviderType;
  api_key: string;
  base_url?: string | null;
}

export interface TestResult {
  valid: boolean;
  response?: string;
  error?: string;
}

// ─── Model constants ───

export const ORCHESTRATOR_MODELS: Record<string, ModelEntry[]> = {
  openai: [
    { id: 'o3', label: 'o3 — 200K ctx' },
    { id: 'o4-mini', label: 'o4-mini — 200K ctx' },
    { id: 'gpt-4.1', label: 'GPT-4.1 — 1M ctx' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini — 1M ctx' },
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano — 1M ctx' },
    { id: 'gpt-4o', label: 'GPT-4o — 128K ctx' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini — 128K ctx' },
    { id: 'o3-mini', label: 'o3-mini — 200K ctx' },
  ],
  anthropic: [
    { id: 'claude-opus-4-20250514', label: 'Claude Opus 4 — 200K ctx' },
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 — 200K ctx' },
    { id: 'claude-haiku-4-20250414', label: 'Claude Haiku 4 — 200K ctx' },
  ],
  custom: [],
};

export const WORKER_MODELS: Record<string, ModelEntry[]> = Object.fromEntries(
  listAgentDefinitions().map((a) => [a.type, a.models]),
);

const DEFAULT_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

// ─── API adapters ───

async function callOpenAI(
  apiKey: string,
  baseUrl: string | null | undefined,
  model: string,
  messages: LlmMessage[],
  options: LlmCallOptions = {},
): Promise<LlmResponse> {
  const url = `${baseUrl || DEFAULT_URLS.openai}/chat/completions`;
  const body = {
    model,
    messages,
    max_tokens: options.maxTokens || 4096,
    temperature: options.temperature ?? 0.2,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    usage: data.usage,
  };
}

async function callAnthropic(
  apiKey: string,
  baseUrl: string | null | undefined,
  model: string,
  messages: LlmMessage[],
  options: LlmCallOptions = {},
): Promise<LlmResponse> {
  const url = `${baseUrl || DEFAULT_URLS.anthropic}/messages`;

  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const msgs = messages.filter((m) => m.role !== 'system');

  const body: Record<string, unknown> = {
    model,
    max_tokens: options.maxTokens || 4096,
    messages: msgs,
  };
  if (system) body.system = system;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const content = data.content?.map((b: { text: string }) => b.text).join('') || '';
  return {
    content,
    usage: data.usage,
  };
}

// ─── Public API ───

export async function callLLM(
  provider: ProviderConfig,
  model: string,
  messages: LlmMessage[],
  options: LlmCallOptions = {},
): Promise<LlmResponse> {
  if (!provider || !provider.api_key) throw new Error('Provider API key not configured');

  switch (provider.type) {
    case 'openai':
    case 'custom':
      return callOpenAI(provider.api_key, provider.base_url, model, messages, options);
    case 'anthropic':
      return callAnthropic(provider.api_key, provider.base_url, model, messages, options);
    default:
      throw new Error(`Unknown provider type: ${provider.type}`);
  }
}

export function getAvailableModels(providerType: string): ModelEntry[] {
  return ORCHESTRATOR_MODELS[providerType] || [];
}

export async function testProvider(provider: ProviderConfig): Promise<TestResult> {
  const testModel = provider.type === 'anthropic' ? 'claude-haiku-4-20250414' : 'gpt-4o-mini';
  try {
    const result = await callLLM(provider, testModel, [
      { role: 'user', content: 'Reply with just "ok"' },
    ], { maxTokens: 10 });
    return { valid: true, response: result.content };
  } catch (err: unknown) {
    return { valid: false, error: (err as Error).message };
  }
}

export function getWorkerModels(workerType: string): ModelEntry[] {
  return getAgentModels(workerType);
}

export function getWorkerTypes(): string[] {
  return getAgentTypes();
}

import type { AgentRegistry } from '../agents/registry';

const CACHE_TTL_MS = 60_000;

export class UsageService {
  private cache: { data: Record<string, unknown>; timestamp: number } | null = null;

  constructor(private registry: AgentRegistry) {}

  async collect(): Promise<Record<string, unknown>> {
    if (this.cache && Date.now() - this.cache.timestamp < CACHE_TTL_MS) {
      return this.cache.data;
    }

    const data: Record<string, unknown> = {};
    for (const provider of this.registry.list()) {
      if (!provider.collectUsage) continue;
      const usage = await provider.collectUsage();
      if (usage) data[provider.definition.type] = usage;
    }

    this.cache = { data, timestamp: Date.now() };
    return data;
  }
}

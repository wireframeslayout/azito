import type { AgentContext, AgentDefinition, AgentModel, IAgentProvider } from './AgentProvider';
import { claudeProvider } from './claude';
import { codexProvider } from './codex';
import { genericProvider } from './generic';

// ─── API-facing definition (definition + derived launch command) ───
//
// フロントは対話起動のプリセット表示・プレビュー生成のため、モデル/追加引数なしの
// 基本起動コマンドを必要とする。IAgentProvider.buildLaunchCommand から導出し、
// definition 側に二重定義しない。

export interface AgentApiDefinition extends AgentDefinition {
  /** モデル・追加引数なしで組み立てた基本起動コマンド。非対話(launchable=false)なら null */
  launchCommand: string | null;
}

// ─── Registry ───

export class AgentRegistry {
  private readonly providers = new Map<string, IAgentProvider>();

  register(provider: IAgentProvider): void {
    const { type } = provider.definition;
    if (this.providers.has(type)) {
      throw new Error(`Agent provider already registered: ${type}`);
    }
    this.providers.set(type, provider);
  }

  get(type: string): IAgentProvider {
    const provider = this.providers.get(type);
    if (!provider) {
      throw new Error(`Unknown agent type: ${type}`);
    }
    return provider;
  }

  tryGet(type: string): IAgentProvider | null {
    return this.providers.get(type) ?? null;
  }

  list(): IAgentProvider[] {
    return Array.from(this.providers.values());
  }
}

export function createDefaultRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(claudeProvider);
  registry.register(codexProvider);
  registry.register(genericProvider);
  return registry;
}

// ─── Context-free singleton(旧 AgentCatalog.AGENTS 相当) ───
//
// 起動コマンド組み立てやカタログ表示 API は DI を必要としないため、既定のレジストリを
// モジュール読み込み時に一度だけ構築して共有する。セッション戦略の構築(TransportFactory
// が必要)は SessionStrategyFactory 側で別途 DI されたレジストリを使う。

export const defaultRegistry = createDefaultRegistry();

// ─── Derived helpers(旧 AgentCatalog の free function 群と同じ形) ───

export function listAgentDefinitions(): AgentApiDefinition[] {
  return defaultRegistry.list().map((p) => ({
    ...p.definition,
    launchCommand: p.definition.launchable
      ? p.buildLaunchCommand({ model: null, extraArgs: null })
      : null,
  }));
}

export function getAgentsForContext(context: AgentContext): AgentApiDefinition[] {
  return listAgentDefinitions().filter((d) => d.contexts.includes(context));
}

export function getAgentModels(type: string): AgentModel[] {
  return defaultRegistry.tryGet(type)?.definition.models ?? [];
}

export function getAgentTypes(): string[] {
  return getAgentsForContext('worker').map((d) => d.type);
}

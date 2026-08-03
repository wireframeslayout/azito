import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { ISessionStrategy } from './SessionStrategy';

// ─── Catalog types (旧 AgentCatalog.AgentDefinition 相当) ───

export type AgentContext = 'worker' | 'subagent';

export interface AgentModel {
  id: string;
  label: string;
}

export interface AgentDefinition {
  type: string;
  label: string;
  kind: 'cli';
  launchable: boolean;
  contexts: AgentContext[];
  models: AgentModel[];
  headlessCommand: string | null;
}

// ─── Launch command types ───

export interface LaunchOptions {
  model?: string | null;
  extraArgs?: string | null;
}

// ─── Session strategy injection ───

export interface SessionStrategyDeps {
  transportFactory: TransportFactory;
}

// ─── Token usage (エージェントごとに形が異なるため緩く型付けする) ───

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ─── 1エージェント種別を完全に記述する束 ───

export interface IAgentProvider {
  /** カタログ情報(type/label/kind/launchable/contexts/models/headlessCommand) */
  readonly definition: AgentDefinition;
  /** tmux ペインでの対話起動コマンドを組み立てる。非対応な組み合わせは null */
  buildLaunchCommand(opts: LaunchOptions): string | null;
  /** ヘッドレス(subagent)実行コマンドを組み立てる。非対応なら null */
  buildHeadlessCommand(model: string): string | null;
  /** セッション再開戦略を組み立てる。非対応なら null(利用側で NullSessionStrategy 相当に落とす) */
  createSessionStrategy(deps: SessionStrategyDeps): ISessionStrategy | null;
  /**
   * トークン使用量を収集する。形はエージェントごとに異なり、JSON としてそのまま API 応答に
   * 載せられればよいため unknown で受ける。対応しないエージェントは実装を省略してよい。
   */
  collectUsage?(): Promise<unknown>;
}

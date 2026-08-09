// エージェント種別ごとのトランスクリプト付帯情報（表示名・割り込みキー）。
// Phase D（会話ビューからの直接操作）で使用予定。現時点では定義のみ。
//
// modules/agents/registry.ts（IAgentProvider）との統合は意図的に見送っている。あちらは
// 「起動コマンドの組み立て」を責務とするレジストリで、トランスクリプト表示専用の付帯情報
// （interruptKey 等）を持たせると責務が広がってしまうため、当面は transcripts モジュール内で
// 独立させる。将来的に統合するかは Phase D 着手時に判断する。

export type InterruptKey = 'Escape' | 'C-c';

export interface AgentTranscriptProfile {
  agentType: string;
  displayName: string;
  interruptKey: InterruptKey;
}

export const AGENT_TRANSCRIPT_PROFILES: AgentTranscriptProfile[] = [
  { agentType: 'claude', displayName: 'Claude', interruptKey: 'Escape' },
  { agentType: 'codex', displayName: 'Codex', interruptKey: 'Escape' },
];

export function getAgentTranscriptProfile(agentType: string): AgentTranscriptProfile | undefined {
  return AGENT_TRANSCRIPT_PROFILES.find((profile) => profile.agentType === agentType);
}

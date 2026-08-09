import { ClaudeTranscriptSource } from './ClaudeTranscriptSource';
import { CodexTranscriptSource } from './CodexTranscriptSource';
import type { TranscriptSource } from './TranscriptSource';

// 本番用の既定ソース群（実ディレクトリを走査する）。テストは ClaudeTranscriptSource /
// CodexTranscriptSource を dirOverride 付きで個別にインスタンス化し、この配列は使わない。
export const claudeTranscriptSource = new ClaudeTranscriptSource();
export const codexTranscriptSource = new CodexTranscriptSource();

export const TRANSCRIPT_SOURCES: TranscriptSource[] = [claudeTranscriptSource, codexTranscriptSource];

export function getSource(agentType: string): TranscriptSource | undefined {
  return TRANSCRIPT_SOURCES.find((source) => source.agentType === agentType);
}

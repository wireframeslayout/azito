import { ClaudeTranscriptSource } from './ClaudeTranscriptSource';
import { CodexTranscriptSource } from './CodexTranscriptSource';
import { LocalTranscriptSource } from './LocalTranscriptSource';
import type { TranscriptReader, TranscriptSource } from './TranscriptSource';

// 本番用の既定 reader 群（実ディレクトリを走査する）。ハブ自身のマシンの会話ログ（local）と、
// エージェントプロセスが自マシンの会話ログを返すとき（agent/transcriptRoutes.ts）の両方が使う。
// テストは ClaudeTranscriptSource / CodexTranscriptSource を dirOverride 付きで個別に
// インスタンス化し、この配列は使わない。
export const claudeTranscriptReader = new ClaudeTranscriptSource();
export const codexTranscriptReader = new CodexTranscriptSource();

export const TRANSCRIPT_READERS: TranscriptReader[] = [claudeTranscriptReader, codexTranscriptReader];

export const claudeTranscriptSource: TranscriptSource = new LocalTranscriptSource(claudeTranscriptReader);

/** ハブ自身のマシン（type=local）の会話ログ。 */
export const TRANSCRIPT_SOURCES: TranscriptSource[] = [
  claudeTranscriptSource,
  new LocalTranscriptSource(codexTranscriptReader),
];

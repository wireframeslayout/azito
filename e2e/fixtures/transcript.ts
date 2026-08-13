// Claude Code のセッション JSONL フィクスチャ。
//
// 稼働検知 Tier 4（WindowSessionResolver.getActivityStatus）は、ウィンドウに紐付いた
// セッションの **末尾の意味あるエントリ** だけを見て working / completed / interrupted を決める
// （mtime は粗い足切りにしか使わない）。ここではその末尾エントリを直接組み立てて、LLM を一切
// 起動せずに各シナリオの transcript 状態を再現する。
//
// 書き込み先は `$CLAUDE_CONFIG_DIR/projects/<project>/<sessionId>.jsonl`
// （ClaudeTranscriptSource.resolveProjectsDir が読む場所）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Tier 4 が読む末尾エントリの種類。 */
export type TranscriptEnding =
  /** ユーザー発話で終わる = エージェントが応答中 → 'working'。 */
  | 'in_progress'
  /** アシスタントの最終テキストで終わる = 完了 → completedAt。 */
  | 'final'
  /** 中断マーカーで終わる = ユーザー中断 → interruptedAt（完了ではない）。 */
  | 'interrupted'
  /** 意味あるエントリが1件も無い（`claude --resume` 直後の housekeeping のみ）→ 判定材料なし。 */
  | 'housekeeping_only';

export interface TranscriptFixture {
  readonly sessionId: string;
  readonly filePath: string;
  /** 末尾エントリを差し替え、timestamp を「いま」に更新する（= 鮮度を保つ）。 */
  write(ending: TranscriptEnding): void;
}

function uuid(): string {
  return crypto.randomUUID();
}

/**
 * `claude --resume` が起動時に書き込む housekeeping レコード群の再現。いずれも
 * `normalizeEntry` で捨てられる（message が無い / type: 'summary'）ため、mtime だけを進めて
 * 意味あるエントリを1件も残さない — リスポーン直後の偽 working を封じている経路そのもの。
 */
function housekeepingRecords(nowIso: string): unknown[] {
  return [
    { type: 'summary', summary: 'e2e fixture', leafUuid: uuid() },
    { type: 'file-history-snapshot', messageId: uuid(), snapshot: {}, timestamp: nowIso },
    { type: 'x-ai-title', uuid: uuid(), timestamp: nowIso, title: 'e2e' },
  ];
}

function tailRecord(ending: Exclude<TranscriptEnding, 'housekeeping_only'>, nowIso: string): unknown {
  switch (ending) {
    case 'in_progress':
      return {
        uuid: uuid(),
        type: 'user',
        timestamp: nowIso,
        message: { role: 'user', content: [{ type: 'text', text: 'e2e: keep working' }] },
      };
    case 'final':
      return {
        uuid: uuid(),
        type: 'assistant',
        timestamp: nowIso,
        message: {
          role: 'assistant',
          model: 'claude-e2e',
          content: [{ type: 'text', text: 'e2e: done' }],
        },
      };
    case 'interrupted':
      // ClaudeTranscriptSource.INTERRUPT_TEXT_PATTERN の完全一致対象。
      return {
        uuid: uuid(),
        type: 'user',
        timestamp: nowIso,
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      };
  }
}

/**
 * 1セッション分の JSONL フィクスチャを作る。`sessionId` は Claude Code と同じ UUID 形式で
 * なければならない（ClaudeTranscriptSource.SESSION_ID_PATTERN）。
 */
export function createTranscriptFixture(claudeConfigDir: string, projectName: string): TranscriptFixture {
  const sessionId = uuid();
  const projectDir = path.join(claudeConfigDir, 'projects', projectName);
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);

  const write = (ending: TranscriptEnding): void => {
    const nowIso = new Date().toISOString();
    const records: unknown[] = housekeepingRecords(nowIso);
    if (ending !== 'housekeeping_only') records.push(tailRecord(ending, nowIso));
    fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };

  return { sessionId, filePath, write };
}

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
  /**
   * リテラルテキスト送信後、送信キー（Enter）を送るまでに空けるミリ秒。Ink 系 TUI（codex）は
   * 貼り付けたテキストが入力欄に反映される前に Enter が届くと無視してしまう（実機・tmux 実証済み:
   * 0ms は再現性100%で失敗、100ms で解消。余裕を持たせて200msを採用）。claude は待ちなしで
   * 既存動作のまま送信される（実証で問題なし）。
   */
  submitDelayMs: number;
  /**
   * このエージェントの CLI が、ローカルスラッシュコマンド実行（例: /model）をセッション JSONL に
   * 'command' エントリとして記録するか（Issue #338 followup）。true（claude）ではチャットビューに
   * コマンド行＋出力が反映されるため入力バーに注記は出さない。false（codex）では TUI ローカル
   * コマンドがログに一切書かれず結果もチャットに反映されないため、フロントの入力バーが「/」始まりの
   * 入力にターミナルモードでの実行を促す注記を出す（PromptInputBar 参照）。
   */
  slashCommandsVisibleInLog: boolean;
  /**
   * Whether this agent's CLI can emit a real-time "waiting for an answer" signal
   * (Phase B, real-time pending-answer detection). 'hook' (claude) means a CLI
   * hook (Notification, `harness/hooks/azito-interaction.sh`) fires
   * `POST /api/webhooks/agent-interaction` while the agent is blocked on
   * AskUserQuestion, driving `InteractionMonitor`'s pending state and the chat
   * banner. 'none' (codex) means no such signal exists — `pendingInteraction` is
   * never true for its windows, and nothing else about its transcript rendering
   * changes.
   *
   * Adding a new agent type touches exactly three things: a TranscriptSource
   * implementation (sources/registry.ts), this declaration, and an adapter if
   * the CLI's hook payload shape differs from azito-interaction.sh's.
   */
  interactionSignal: 'hook' | 'none';
}

export const AGENT_TRANSCRIPT_PROFILES: AgentTranscriptProfile[] = [
  { agentType: 'claude', displayName: 'Claude', interruptKey: 'Escape', submitDelayMs: 0, slashCommandsVisibleInLog: true, interactionSignal: 'hook' },
  { agentType: 'codex', displayName: 'Codex', interruptKey: 'Escape', submitDelayMs: 200, slashCommandsVisibleInLog: false, interactionSignal: 'none' },
];

export function getAgentTranscriptProfile(agentType: string): AgentTranscriptProfile | undefined {
  return AGENT_TRANSCRIPT_PROFILES.find((profile) => profile.agentType === agentType);
}

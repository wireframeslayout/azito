// チャット内での AskUserQuestion 回答（Issue #338 選択肢タップ）を、LLM も実 Claude Code も
// 起動せずに一本の経路として検証する。
//
// hook（harness/hooks/azito-question.sh）自体は Claude Code の PermissionRequest イベントでしか
// 発火しないため E2E からは起こせない。代わりに、その hook が投げるのと同じ HTTP リクエスト
// （content 付き POST /api/webhooks/agent-interaction）をハーネスから直接注入する — 検証したいのは
// 「質問内容付きシグナル → チャットの回答カード → 押した選択肢の数字キーがペインへ届く →
//  ログ確定で回答済みカードに置き換わる」という経路であって、hook のペイン特定ロジックではない。
//
// 「ペインへ届いた」ことは偽エージェントの入力記録（fake-agent の第3引数）で確かめる。画面表示に
// 頼らないので、tmux の描画タイミングに左右されない。

import { test, expect } from '../fixtures/test';
import { createTranscriptFixture } from '../fixtures/transcript';

const TMUX_SESSION = 'e2e-qa';
const QUESTION = 'どちらの方針で進めますか?';
const OPTION_KEEP = 'このまま進める';
const OPTION_STOP = 'いったん止める';

/** 数字キーがペインに届くまでに許す最大遅延（HTTP 往復 + tmux send-keys + 偽エージェントの追記）。 */
const KEYSTROKE_BUDGET_MS = 10_000;

test('チャットの選択肢タップで AskUserQuestion に回答できる', async ({ app, harness }) => {
  const label = 'e2e-answer';
  // 非 ASCII だけの名前は slug が他スペックのプロジェクトと衝突する（projects.slug は UNIQUE）ため、
  // ASCII で一意な名前にする。
  const projectId = await harness.createProject('e2e-chat-answer');

  // 偽エージェント → セッション JSONL の順に用意する（プロセス起動より後にセッションが更新される、
  // 実運用と同じ前後関係にするため）。in_progress = 末尾がユーザー発話 = 応答待ちの体裁で、
  // pendingInteraction のゲート（tailState === 'in_progress'）を満たす。
  const agent = await harness.startFakeAgent(TMUX_SESSION, 'answer', { supervised: false, recordInput: true });
  const fixture = createTranscriptFixture(harness.claudeConfigDir, '-e2e-answer');
  fixture.write('in_progress');
  const windowId = await harness.registerAgentWindow(projectId, agent.target, { label, agentSessionId: fixture.sessionId });

  // hook 相当の content 付きシグナル。
  await harness.sendInteractionSignal(agent.target, {
    toolName: 'AskUserQuestion',
    questions: [
      {
        question: QUESTION,
        header: '方針',
        multiSelect: false,
        options: [{ label: OPTION_KEEP }, { label: OPTION_STOP, description: '確認してから再開する' }],
      },
    ],
  });

  // ウィンドウをチャット表示で開く（端末 WS を張らずに ConversationView へ入るための既定値）。
  await app.addInitScript(([id]) => {
    localStorage.setItem(`azito.windowView.${id}`, 'chat');
  }, [windowId]);

  await app.goto(`${harness.baseUrl}/workspace/${projectId}`);
  await app.getByPlaceholder('タイトル・ID・ブランチで検索…').fill(label);
  await app.locator('.row-hover').filter({ hasText: label }).first().click();

  // 回答可能な質問カード（バナーではない）が出る。
  await expect(app.getByText(QUESTION)).toBeVisible();
  await expect(app.getByRole('option', { name: new RegExp(OPTION_STOP) })).toBeVisible();
  await expect(app.getByText('エージェントが入力を待っています', { exact: false })).toHaveCount(0);

  // 2つめの選択肢をタップ → ペインには '2' が届く。
  await app.getByRole('option', { name: new RegExp(OPTION_STOP) }).click();
  await expect(app.getByText('回答を送信しました…')).toBeVisible();
  await expect.poll(() => agent.readInput(), { timeout: KEYSTROKE_BUDGET_MS }).toContain('2');

  // ログ確定（回答済みの interaction エントリ）で、送信中カードが正典の回答済みカードへ置き換わる。
  fixture.appendAnsweredQuestion(QUESTION, [OPTION_KEEP, OPTION_STOP], OPTION_STOP);
  await expect(app.getByText('回答を送信しました…')).toHaveCount(0);
  await expect(app.getByText(QUESTION)).toBeVisible();

  await harness.deleteWindow(windowId);
});

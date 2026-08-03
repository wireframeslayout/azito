# タスク実行プロセス — 新規設計書

## 概要

state-machineモードのタスク実行において、tmuxペイン上のエージェント（Claude Code等）の出力をリアルタイムに監視し、フェーズ完了・質問・エラーを検出してタスクの状態遷移を行う。

## アーキテクチャ

```
ExecuteTaskUseCase
  └─ PhaseLoopRunner.stateMachineLoop (フェーズごとにループ)
       ├─ 1. pipe-pane 開始（ANSI除去済み出力をファイルに書き出す）
       ├─ 2. sendKeys でプロンプト送信
       ├─ 3. WorkerWaiter.waitForWorker（ファイルを tail -f 的に監視、マーカー検出）
       ├─ 4. 結果に応じて状態遷移
       └─ 5. pipe-pane 停止、ファイル削除
```

## UnitType / WorkerRuntime / Execution Envelope の関係

```
UnitType (TOML 定義: harness/unit-types/*.toml)
  ├── name, label, description
  └── phases[] ─── UnitTypePhase
                      ├── name, label, tags[]
                      ├── questions, testFailed, planApproval  ← PhaseSignalCapability
                      ├── selfReviewRetry, testFailedRollbackTo, pushVerify
                      ├── subagentRole?, skillCommand?
                      └── defaultSidekick?
                            │
                            ▼
                    resolvePhaseSidekick() ── SidekickPackage (SKILL.md body)
                            │
                            ▼
                    Execution Envelope (executionEnvelope.ts)
                      ├── stateMachineEnvelope()  ← tmux-pipe モード用
                      ├── httpSignalEnvelope()     ← http-signal モード用
                      └── skillEnvelope()          ← /azt-* スキル用
                            │
                            ▼ body + <completion_signal> を結合
                    Worker (claude/codex/generic) に送信

WorkerRuntime (IWorkerRuntime)
  ├── TuiWorkerRuntime    ← tui-supervisor ベース（ローカルサーバー）
  └── LegacyWorkerRuntime ← 旧 tmux 直接操作方式
```

## 主要コンポーネント

### 1. pipe-pane コマンド

```bash
tmux pipe-pane -O -t <target> "stdbuf -o0 sed -u \
  -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' \
  -e 's/\x1b][^\x07]*\x07//g' \
  -e 's/\x1b[()][0-9A-Z]//g' \
  -e 's/\x1b[<>=]//g' \
  >> <output-file>"
```

- `-O`: 出力のみキャプチャ（入力を除く）
- `sed -u`: アンバッファードモード
- `stdbuf -o0`: 出力バッファ完全無効化
- ANSI/OSC/DEC シーケンスを除去してクリーンテキストを出力

### 2. 一意マーカー

フェーズごとに動的生成：
- **完了マーカー**: `AZITO_DONE_<taskId>_<6文字nonce>`
- **質問マーカー**: `AZITO_QUESTIONS_<taskId>_<6文字nonce>`
- **テスト失敗マーカー**: `AZITO_TEST_FAILED_<taskId>_<6文字nonce>`（testing フェーズのみ）

マーカーの出力指示は、レンダリング済みプロンプト本文に **実行エンベロープ**
（`modules/prompt/executionEnvelope.ts` の `stateMachineEnvelope()`）が `<completion_signal>`
ブロックとして付加する。エージェントは指示に従い、フェーズ成果物を出力ファイル
（`/tmp/azito-output-<taskId>-<nonce>.md`、末尾に `AZITO_PHASE_SUMMARY` 行）へ書き出したうえで、
完了マーカーを **シグナルファイル**（`/tmp/azito-pipe-<taskId>-sig-*.log`）へ `echo >> ` で追記する。
本文中に残る旧 `PHASE_COMPLETE` トークンは一意完了マーカーに置換される（互換動作）。

### 3. ファイル監視（WorkerWaiter.waitForWorker）

**方式**: `child_process.spawn('tail', ['-f', filePath])` で stdout をストリーム読み取り
（実装: `modules/tmux/PaneOutputStream.ts` の `PaneOutputStream`。リモートは SSH exec 経由の
`SshPaneStream`、agent サーバーは WebSocket file-tail 経由の `AgentPaneStream`）。
マーカー検出はシグナルファイル用の別ストリーム、ペイン出力ストリームは確認プロンプト自動応答と
アイドル検出に使う。

`tail -f` を使う理由：
- `readSync` + offset 管理の複雑さを回避
- `fs.watch` の信頼性問題を回避
- ファイルが成長する限りリアルタイムに新しい行が流れる
- Node.js の `spawn` で stdout を readline で行単位に読める

```typescript
const tail = spawn('tail', ['-f', '-n', '+1', filePath]);
const rl = readline.createInterface({ input: tail.stdout });

rl.on('line', (line) => {
  const trimmed = line.trim();
  
  // 完了マーカー検出（行頭一致）
  if (trimmed.startsWith(doneMarker)) {
    resolve({ status: 'phase_complete' });
  }
  
  // 質問マーカー検出（行頭一致 + JSONパース）
  if (trimmed.startsWith(questionsMarker + ':')) {
    const json = trimmed.slice(questionsMarker.length + 1).trim();
    const questions = parseQuestionsJson(json);
    if (questions) resolve({ status: 'question', questions });
  }
  
  // 確認プロンプト自動応答
  if (CONFIRMATION_PATTERNS.some(p => p.test(trimmed))) {
    tmux.sendKeys(server, target, ['y', 'Enter']);
  }
});
```

### 4. マーカー検出の優先順位

1. **QUESTIONS**: エージェントが質問を出した → `waiting_input` に遷移、UIで質問表示
2. **DONE**: フェーズ完了 → 次のフェーズへ（planApproval 付きフェーズなら `phase_review`）
3. **最大アイドル** (300秒出力変化なし): 停止扱いの判定へ（完了プローブ確認後）
4. **アイドルタイムアウト** (120秒データなし): LLM分類でフォールバック判定

QUESTIONS を DONE より優先する理由: エージェントが質問を出してからDONEを出さないケースがある。

### 5. プロンプトへの指示（実行エンベロープ）

マーカー出力の指示は Sidekick 本文には書かず、`stateMachineEnvelope()` が本文の末尾に
`<completion_signal>` ブロックとして付加する（Issue #263 Refine D）。概形：

```
STEP 1 — フェーズ成果物を出力ファイルへ書き出す（末尾に AZITO_PHASE_SUMMARY 行）:
  cat > /tmp/azito-output-11-abc123.md <<'AZITO_EOF' ...
STEP 2 — 最後の操作としてシグナルファイルへ完了マーカーを追記:
  echo "AZITO_DONE_11_abc123" >> <signal-file>
質問がある場合（planning/implementing のみ）:
  echo 'AZITO_QUESTIONS_11_abc123: [{"text":"質問","type":"select","options":["A","B"]}]' >> <signal-file>
```

### 6. 質問の構造化

```typescript
interface PaneQuestion {
  text: string;
  type: 'select' | 'text';
  options?: string[];     // select の場合のみ
  selected?: number;      // 現在選択中のインデックス
}
```

エージェントがすべての質問を1行のJSONで出力。ブラケットカウントでネストした配列をパース。

### 7. 状態遷移

```
open → running → (質問あり: waiting_input → 回答 → running に戻る)
                → (planApproval 付きフェーズ完了: phase_review → 承認 → 次フェーズ → ...)
                → running → ... → review/done
```

- `running`: フェーズ実行中（UnitType のフェーズ定義順に進行）
- `waiting_input`: エージェントが質問中。UIに質問を表示し、ユーザーが回答
- `phase_review`: フェーズ成果物を表示し、ユーザーが承認/却下

### 8. pipe-pane と capture-pane の役割分離（重要）

**pipe-pane はマーカー検出専用**。出力内容の抽出には使わない。

理由: pipe-pane の出力は Claude Code の UI 再描画（ステータスバー、区切り線、プロンプト表示の繰り返し）で汚染される。`sed -u` で ANSI を除去しても、`⏵⏵ bypass permissions on` や `────` の繰り返しが大量に残り、実装計画等のテキスト抽出が困難。

```
シグナルファイル (tail -f) の役割: マーカー (AZITO_DONE / AZITO_QUESTIONS / AZITO_TEST_FAILED) の検出
出力ファイル (/tmp/azito-output-*) の役割: フェーズ成果物 + AZITO_PHASE_SUMMARY の取得
pipe-pane の役割: 確認プロンプト自動応答・アイドル検出（内容抽出には使わない）
capture-pane の役割: 出力ファイルが取れない場合のフォールバック抽出
```

#### planMarkdown の抽出フロー

1. シグナルファイルで `AZITO_DONE` マーカーを検出
2. `WorkerWaiter.readPhaseOutputFile()` で出力ファイル（`/tmp/azito-output-<taskId>-<nonce>.md`）を読む
3. 出力ファイルから取れない場合は `extractPlanWithFallback()` が capture-pane（スクロールバッファ）から
   計画テキストを抽出（テンプレートプレースホルダーを含まない出現を検索し、`AZITO_DONE` マーカー直前まで）

#### QUESTIONS_JSON の抽出フロー

1. シグナルファイルで `AZITO_QUESTIONS` マーカー行を検出
2. マーカー行自体に JSON が含まれるのでそのままパース
3. パース失敗時は capture-pane にフォールバック

### 9. 既存テスト

| テストファイル | 対象 |
|---|---|
| `modules/tasks/execution/ExecuteTaskUseCase.test.ts` | extractPlanMarkdown, extractQuestionsJson, 一意マーカー |
| `modules/tasks/execution/PhaseLoopRunner.test.ts` | フェーズループ・状態遷移 |
| `modules/llm/PaneClassifier.test.ts` | マーカー検出、LLMフォールバック、テンプレート除外 |
| `modules/tmux/PaneOutputStream.test.ts` | ファイル監視、マーカー検出、初期バッファ除外 |

### 10. 注意事項

- **Enter 問題**: paste-buffer 後の Enter が Claude Code で無視されることがある。2秒の遅延で緩和しているが完全ではない。pipe-pane で出力を監視し、一定時間出力がなければ Enter を再送する仕組みが有効
- **リモートサーバー**: pipe-pane の出力ファイルはリモート側に作成される。SSH サーバーは `SshPaneStream`（SSH exec で `tail -f`）、agent サーバーは `AgentPaneStream`（agent プロセスの WebSocket file-tail）でリモートファイルを監視する
- **worktree**: タスクごとに git worktree を作成し、隔離されたブランチで作業。デフォルトブランチの設定（`master` vs `main`）に注意
- **implementing プロンプトに計画を含める**: `{{task.plan}}` テンプレート変数で planMarkdown を渡す（マイグレーション019）

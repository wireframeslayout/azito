# herdr ドライバ (PoC)

herdr v0.8.2 を AZITO の mux ドライバとして使用するための手順と制約。

## 前提

- herdr v0.8.2（Rust 製・エージェント認識型マルチプレクサ、herdrdev/herdr）
- root 権限不要（ユーザー領域インストール）
- 公式ドキュメント: https://herdr.dev/docs/
- API スキーマ: `docs/ja/mux-herdr.schema.json`（protocol 20、schema_version 1）

## インストール

```bash
bash harness/mux/herdr/install.sh
# → ~/.local/bin/herdr に配置（sha256 検証付き）
```

## 起動

```bash
bash harness/mux/herdr/start.sh
# HERDR_SESSION=azito herdr server でヘッドレス起動
# systemd --user が利用可能な場合はユニットとして、それ以外は nohup
```

ソケット: `~/.config/herdr/sessions/azito/herdr.sock`

設定ファイル（`harness/mux/herdr/azito.toml`）で以下を無効化:
- サイドバー、タブバー（1 tab 時）、ペイン境界線/ギャップ/スクロールバー、マウスキャプチャ、確認ダイアログ

`start.sh` は `~/.config/herdr/config.toml` にデプロイし、既に起動中のサーバーには `server.reload_config` RPC でリロードする。

## MuxRef 形式

```json
{"kind":"herdr","workspace":"<workspace label>","window":"main"}
```

- `workspace`: herdr ワークスペースラベル = AZITO の窓名
- `window`: 固定値 `"main"`（表示には使用しない）

### 写像規則

AZITO の窓 = herdr workspace。1 workspace に tab は 1 つだけ使用し、2 つ目以降の tab は無視する（診断ログに warn）。

| AZITO の概念 | herdr の概念 |
|---|---|
| コンテナ（セッション） | herdr session（固定: `azito`） |
| 窓（window） | herdr workspace |
| ペイン（pane） | workspace 内の最初の tab の pane |

- `openWindow()` は `workspace.create` を呼ぶ（`tab.create` ではない）
- `closeWindow()` は `workspace.close` を呼ぶ
- `renameWindowByRef()` は `workspace.rename` を呼ぶ
- `windowExists()` は workspace ラベルの存在のみで判定（`ref.window` は無視）

### 旧形式 ref のフォールバック

`{"kind":"herdr","workspace":"azito","window":"win--abc"}` のような旧形式 ref（`window` が実際の tab ラベル）は、`resolvePane` / `listPanesByRef` で workspace が見つからない場合に tab ラベルによるフォールバック解決を行う。migration は追加しない。

## agent 側 attach

`AZITO_MUX_RUNTIME=herdr` の場合、agent プロセスは `HERDR_SESSION`（デフォルト `azito`）から `HerdrSocketClient` を生成する。ターミナル接続時（`/ws?ref=<herdr ref>&pane=1`）、agent はソケット経由で対象タブ/ペインにフォーカスしてから `herdr`（TUI クライアント）を起動する。`start.sh` で `azito.toml` をデプロイし、マウスキャプチャ（`?1000h`）が抑制されていること。

## AZITO への登録

サーバー追加画面で `mux_runtime` に `herdr` を選択。既存 tmux サーバーとは別名で登録（例: `server007-herdr`）。

## プロトコル特性

- **1 接続 1 リクエスト**: サーバーはレスポンス 1 行返却後に接続を閉じる。`events.subscribe` のみ接続を保持
- ID 形式: workspace `w1`、tab `w1:t1`、pane `w1:p1`
- `workspace.create` / `tab.create` の `name` パラメータは label に反映されない → 作成直後に `workspace.rename` / `tab.rename` が必要

## 対応機能（caps）

| 機能 | 対応 | herdr API | 備考 |
|------|------|-----------|------|
| outputStream | **非対応** | — | `pipe-pane` 相当なし。タスク実行は 409 |
| changeEvents | 対応 | `events.subscribe` | 組み込みイベント |
| agentState | 対応 | `pane.agent_status_changed` | mux 側がエージェント稼働状態を提供 |
| independentClients | 対応 | — | 検証①で確認予定 |
| envInjection | 対応 | `workspace.create` / `tab.create` / `pane.split` の `env` | |
| zoom | 対応 | `pane.zoom` | |
| copyMode | 非対応 | — | |
| paneTitle | 対応 | `pane.rename` | |
| activityCounter | 非対応 | — | `window_activity` 相当なし |
| layoutSnapshot | 対応 | `layout.export` / `layout.apply` | |

## 既知の制約

- **タスク実行不可**: `outputStream=false` → `AZITO_DONE_*` マーカー検出のストリーミングが不可。409 `mux_capability_missing`
- **pane.read の空 text**: クライアント未 attach 時、`pane.read` で `text` が空・`revision` 0 のケースがある（PTY サイズ未確定の可能性）
- **稼働検知**: 診断パネルに `decidedBy: 'tier0_mux'` 表示のみ。判定経路への組み込みは未実装
- **done→idle のティア帰属**: herdr が `done` を報告した tick では `tier0_mux` で idle 判定されるが、done エントリは即座に消去され、以後の tick は `tier3_heuristic` に帰属する。これは意図的な設計（ウィンドウ再利用時の競合防止）。詳細は `docs/ja/activity-detection.md`「done→idle のティア遷移」を参照

## TmuxClient 直結モジュール棚卸し

herdr / zellij サーバーで `TmuxClient` 具象に依存するモジュールの一覧と縮退動作。
`IMuxClient` 経由（`MuxDriverRegistry.resolve()`）で呼ばれる箇所は herdr/zellij ドライバが透過的に処理するため問題なし。
`TmuxClient.execCommand()` は tmux 固有のシェルコマンド実行であり、herdr/zellij には等価 API がない。

| モジュール | 使用メソッド | 縮退動作 |
|---|---|---|
| `operations/AgentActivityMonitor` | `listSessions`, `captureScreen` | `listSessions`: MuxDriverRegistry 経由で解決済み。`captureScreen`: Tier 2 画面取得で使用、herdr は `IMuxClient.captureScreen` で対応 |
| `windows/WindowSleepService` | `closeWindow` | tmux 直結。herdr サーバーではスリープ機能未対応（要対応） |
| `windows/WindowRespawnService` | `listSessions`, `createSession`, `createWindow`, `resolvePane`, `closeWindow`, `sendKeysToHandle`, `captureLayout`, `splitPaneByHandle`, `applyLayout`, `listPanesByRef` | tmux 直結。herdr サーバーでは respawn 未対応（要対応） |
| `git/RepoDiscoveryService` | `execCommand` | tmux 固有。herdr/zellij では `execCommand` 不可。agent サーバーは `AgentTransport.exec()` 経由で動作するため影響なし |
| `files/FileBrowseService` | `execCommand` | 同上。agent サーバーは transport 経由 |
| `tasks/execution/GitInfoCollector` | `execCommand` | 同上 |
| `tasks/execution/PushVerifier` | `execCommand` | 同上 |
| `tasks/execution/WorkerInputService` | `getPaneCurrentCommand`, `sendKeysToHandle` | MuxDriverRegistry fallback で解決済み |
| `tasks/execution/WindowRotation` | `closeWindow`, `closePane`, `uiTokenEnvForServer` | IMuxClient 経由で解決済み |
| `tasks/TaskRestoreService` | `createWindow`, `resolvePane`, `sendKeysToHandle`, `closeWindow` | tmux 直結。herdr サーバーでのタスク復元は未対応（要対応） |
| `tasks/recovery/RecoverStuckTasksUseCase` | `resolvePane`, `probePane`, `sendKeysToHandle` | **7-H で MuxDriverRegistry 経由に修正済み** |
| `tasks/TaskCleanupService` | `closeWindow` | MuxDriverRegistry fallback 済み |
| `transcripts/WindowSessionResolver` | `execCommand`, `getPanePid`, `listAllPanes`, `listSessions` | tmux 固有。herdr サーバーでは縮退（セッション解決不可、機能低下） |
| `transcripts/WindowInputService` | `sendLiteralText`, `sendKeysToHandle`, `isPaneInMode`, `cancelPaneMode`, `listAllPanes` | tmux 直結。herdr サーバーでは入力送信が低下（要対応） |
| `transcripts/TranscriptPaneService` | `listAllPanes`, `checkPaneExists`, `sendLiteralText`, `sendKeysToHandle` | tmux 直結。herdr サーバーでは縮退 |
| `servers/routes` | `listSessionsForSecurityGate`, `execCommand` | `listSessionsForSecurityGate`: 隔離ゲートで使用、herdr サーバーでは MuxDriverRegistry 経由の `listWorkspaces` に要移行。`execCommand`: tmux バージョン確認用、herdr では不要 |
| `tasks/routes` | `windowExists`, `closeWindow` | tmux 直結。MuxDriverRegistry 経由への移行が望ましい |

### 分類

- **(a) IMuxClient / MuxDriverRegistry 経由で解決済み**: AgentActivityMonitor, WorkerInputService, WindowRotation, TaskCleanupService, RecoverStuckTasksUseCase
- **(b) `execCommand` 依存（tmux 固有コマンド実行）**: RepoDiscoveryService, FileBrowseService, GitInfoCollector, PushVerifier — agent サーバーは `AgentTransport.exec()` で動作するため herdr/zellij でも無害
- **(c) 未対応（herdr/zellij 本格対応時に要移行）**: WindowSleepService, WindowRespawnService, TaskRestoreService, WindowSessionResolver, WindowInputService, TranscriptPaneService, servers/routes (一部), tasks/routes (一部)

## 検証結果

> `scripts/poc/herdr-verify.ts` の実行結果を転記する。

### ①複数クライアントの独立フォーカス
_未実施_

### ②env 注入
_未実施_

### ③pane.send_text サイズ上限
_未実施_

### ④生出力ストリーム代替（pane.read ポーリング + pane.wait_for_output）
_未実施_ — pane.read の空 text 問題（クライアント未 attach 時）も要確認

### ⑤タブバー非表示
_未実施_

## クライアント設定とナビゲーションロック

### 概要

AZITO は herdr のクライアント設定ファイルを 2 種類生成し、AZITO から開くターミナルに専用の設定を適用する。

- `~/.azito/herdr/client-locked.toml` — workspace/tab 移動系キーバインドを無効化
- `~/.azito/herdr/client-free.toml` — UI 推奨値のみ（キーバインド制限なし）

### ロックの範囲

**ロックは AZITO が張ったクライアントにのみ効く。** サーバーで直接 `herdr` コマンドを実行して開くクライアントには影響しない。AZITO はターミナル接続時に `HERDR_CONFIG_PATH` 環境変数でクライアント設定ファイルを指定するため、その環境変数が設定されていない通常の herdr クライアントはサーバーの既定設定（`~/.config/herdr/config.toml`）を使用する。

### 設定の優先順位

1. 窓（Window）の `herdrNavigationLock`（`'locked'` / `'free'` / `null`）
2. サーバーの `herdrNavigationLock`（`'locked'` / `'free'`、既定 `'locked'`）

窓の値が `null`（サーバー既定に従う）の場合、サーバーの値が使われる。

### UI 推奨値の診断

Settings → Servers でサーバーの `~/.config/herdr/config.toml` を確認し、以下の推奨値と異なる場合に警告を表示する（自動修正はしない）:

| キー | 推奨値 |
|------|--------|
| `hide_tab_bar_when_single_tab` | `true` |
| `sidebar_collapsed_mode` | `"hidden"` |
| `mouse_capture` | `true` |

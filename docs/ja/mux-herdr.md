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

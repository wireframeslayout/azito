# herdr ドライバ (PoC)

herdr v0.8.2 を AZITO の mux ドライバとして使用するための手順と制約。

## 前提

- herdr v0.8.2（Rust 製・エージェント認識型マルチプレクサ）
- root 権限不要（ユーザー領域インストール）
- 公式ドキュメント: https://herdr.dev/docs/

## インストール

```bash
# リポジトリ同梱のインストールスクリプトを使用
bash harness/mux/herdr/install.sh
# → ~/.local/bin/herdr に配置される（sha256 検証付き）
```

## 起動

```bash
# herdr サーバーをヘッドレスモードで起動
bash harness/mux/herdr/start.sh
# systemd --user が利用可能な場合はユニットとして起動、
# それ以外は nohup で起動される
```

設定ファイル（`harness/mux/herdr/azito.toml`）により、以下の UI 要素が自動で無効化される:
- サイドバー（非表示）
- タブバー（1 タブ時非表示）
- ペイン境界線・ギャップ・スクロールバー
- マウスキャプチャ
- 閉じる確認ダイアログ

## AZITO への登録

サーバー追加画面で `mux_runtime` に `herdr` を選択する。

- 既存の tmux サーバーとは別名で登録すること（例: `server007-herdr`）
- herdr サーバーが起動中であること

## 対応機能（caps）

| 機能 | 対応 | 備考 |
|------|------|------|
| outputStream | **非対応** | `pipe-pane` 相当なし。タスク実行は不可 |
| changeEvents | 対応 | `events.subscribe` による組み込みイベント |
| agentState | 対応 | `pane.agent_status_changed` でエージェント稼働状態を取得 |
| independentClients | 対応 | 複数クライアントの独立フォーカス |
| envInjection | 対応 | `workspace.create`/`tab.create`/`pane.split` で `env` パラメータ |
| zoom | 非対応 | |
| copyMode | 非対応 | |
| paneTitle | 非対応 | |
| activityCounter | 非対応 | `window_activity` 相当なし |
| layoutSnapshot | 非対応 | |

## 既知の制約

- **タスク実行不可**: `outputStream=false` のため、`AZITO_DONE_*` マーカー検出に必要なペイン出力のストリーミングができない。タスク実行を試みると 409 `mux_capability_missing` が返る
- **pane.read ポーリング**: 出力ストリームの代替として `pane.read` のポーリングが考えられるが、信頼性は検証項目④で確認中
- **稼働検知**: 診断パネル（`GET /api/debug/activity`）に `decidedBy: 'tier0_mux'` として表示されるが、判定経路への組み込みは未実装（Issue #155 統合後に対応）

## 検証結果

> 以下は `scripts/poc/herdr-verify.ts` の実行結果を転記する。

### ①複数クライアントの独立フォーカス

_未実施_

### ②env 注入

_未実施_

### ③pane.send_text サイズ上限

_未実施_

### ④生出力ストリーム代替

_未実施_

### ⑤タブバー非表示

_未実施_

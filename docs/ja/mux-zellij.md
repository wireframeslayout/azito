# zellij ドライバ (PoC)

zellij v0.45.1 を AZITO の mux ドライバとして使用するための手順と制約。

## 前提

- zellij v0.45.1 (Rust 製ターミナルマルチプレクサ、zellij-org/zellij)
- root 権限不要 (ユーザー領域インストール)
- 公式ドキュメント: https://zellij.dev/documentation/
- 外部制御は `zellij action` CLI 経由。イベント通知は WASM プラグイン自作が前提 (本 PoC ではポーリング縮退)

## インストール

```bash
bash harness/mux/zellij/install.sh
# → ~/.local/bin/zellij に配置 (sha256 検証付き、musl 静的リンク版)
```

## 設定

```bash
mkdir -p ~/.config/zellij/layouts
cp harness/mux/zellij/config.kdl ~/.config/zellij/config.kdl
cp harness/mux/zellij/azito-layout.kdl ~/.config/zellij/layouts/azito.kdl
```

`config.kdl` の主要設定:

| 設定 | 値 | 目的 |
|------|-----|------|
| `simplified_ui` | `true` | UI 要素を最小化 |
| `pane_frames` | `false` | ペイン枠を非表示 |
| `mirror_session` | `false` | クライアントごとに独立したタブ選択 |
| `default_layout` | `"azito"` | tab-bar/status-bar を含まないレイアウト |
| `mouse_mode` | `false` | ターミナルパススルーのためマウス無効 |

`azito-layout.kdl` は tab-bar、status-bar を含まない最小レイアウト。

## セッション起動

```bash
zellij --session azito --new-session
# バックグラウンド (クライアント未 attach) で起動
# 既存セッションがある場合は attach
```

zellij はデーモンモードを持たない。最初のクライアント attach 時にサーバープロセスが起動し、全クライアントが切断しても一定時間残る。

## MuxRef 形式

```json
{"kind":"zellij","workspace":"<session 名>","window":"<tab 名>"}
```

- `workspace`: zellij セッション名（例: `"azito"`）
- `window`: zellij タブ名（例: `"win--abc"`）

## ヘッドレス制約と常駐クライアント

ヘッドレスセッション（クライアント未接続）では `new-tab` が空タブ（ターミナルペイン 0 個）を作成する（`--layout-string` 指定時も同様）。ペインのないタブ:

- `list-panes --all --json` に出現しない
- `query-tab-names` には表示されるが tab_id の相関が不安定
- ペインが存在するまで操作不可（capture, send-keys, split）

### 常駐クライアント方式（段階7-G で導入）

`ZellijResidentClient` が `zellij attach <session>` を node-pty (200×50) で 1 本保持することで、セッションは「クライアントあり」になりタブ/ペイン作成が正常に動作する。

| 検証項目 | 結果 |
|---------|------|
| (a) `new-tab --name X` でペインが生えるか | **成立** — terminal pane が 1 個作成される |
| (b) `--layout-string 'layout { pane; }'` | **成立** — (a) と同等 |
| (c) `go-to-tab-name X` → `new-pane` が X に作られるか | **成立** — 常駐クライアントのフォーカスが移動し、正しいタブにペイン作成 |
| (d) 常駐クライアントの端末サイズが新ペインに影響するか | **影響あり** — ペインサイズは常駐クライアントの viewport (80×24 実測) に依存。node-pty 200×50 指定で十分な初期サイズを確保 |
| (e) `mirror_session false` で独立フォーカス | **成立** — `go-to-tab-name` は常駐クライアントのフォーカスのみ変更。CLI の `action` コマンドは常駐クライアントのフォーカスを操作 |
| (extra) `new-pane -- env KEY=VAL /bin/bash` | **成立** — 環境変数がペインに正しく渡される |

**重要**: `new-pane` に `--tab-id` フラグはない。タブを指定してペインを作るには `go-to-tab-name` → `new-pane` の 2 ステップが必要（`withSessionLock` で直列化）。

`resolveTabId` のフォールバックは `query-tab-names` のインデックスを tab_id として使用する（新規セッションで position == id の場合のみ正確）。

## AZITO への登録

サーバー追加画面で `mux_runtime` に `zellij` を選択。既存 tmux サーバーとは別名で登録 (例: `server007-zellij`)。

## 対応機能 (caps)

| 機能 | 対応 | zellij CLI | 備考 |
|------|------|-----------|------|
| outputStream | **非対応** | -- | `pipe-pane` 相当なし。タスク実行は 409 |
| changeEvents | **非対応** | -- | イベント通知なし。5 秒ポーリング縮退 |
| agentState | **非対応** | -- | 稼働検知なし (Tier 2 画面分類は `captureScreen` 経由で有効) |
| independentClients | 対応 | `mirror_session false` | クライアントごとに独立したタブフォーカス |
| envInjection | 対応 | `new-pane -- env KEY=VAL cmd` | |
| zoom | 対応 | `toggle-fullscreen --pane-id` | pane ID 指定でフルスクリーントグル |
| copyMode | **非対応** | -- | |
| paneTitle | 対応 | `rename-pane --pane-id` | |
| activityCounter | **非対応** | -- | `window_activity` 相当なし |
| layoutSnapshot | 対応 | `dump-layout` | KDL 形式のレイアウト出力 |
| stablePaneHandle | 対応 | `list-panes --all --json` | `terminal_N`/`plugin_N` の安定 ID |

## 既知の制約

- **タスク実行不可**: `outputStream=false` により `AZITO_DONE_*` マーカー検出のストリーミングが不可。409 `mux_capability_missing`
- **イベント遅延**: セッション/タブ変更の検知に最大 5 秒 (ポーリング間隔)。tmux hook (<1s) / herdr event (<100ms) と比較して劣る
- **稼働検知**: `agentState=false`。Tier 0 のドライバ直接検知は不可。Tier 2 の `captureScreen` 経由の画面分類で代替

## プラグイン要否判断

### (a) ポーリング縮退での反映遅延

セッション/タブの変更検知は 5 秒間隔のポーリング。UI サイドバーの更新に体感的なラグがある。WASM プラグインで `TabUpdate` / `PaneUpdate` イベントを購読すれば即時通知が可能。

### (b) フォーカス依存操作

0.45.1 では以下のコマンドが `--pane-id` / `--tab-id` を受け付けるため、フォーカス依存は大幅に解消:

- `write-chars --pane-id` / `write --pane-id` -- テキスト/バイト送信
- `dump-screen --pane-id` -- 画面キャプチャ
- `close-pane --pane-id` / `close-tab --tab-id` -- 削除
- `rename-tab --tab-id` / `rename-pane --pane-id` -- リネーム
- `new-pane --tab-id --no-focus` -- ペイン作成

`go-to-tab-name` のみフォーカス依存だが、ターミナル接続時の初期タブ選択にしか使わない。並列タスクでの問題は限定的。

### (c) WASM プラグイン見積り

`zellij-tile` crate で Rust 実装。最小構成 (イベント通知 + pane_id エクスポート) は 200-400 行 Rust。ビルドは `cargo build --target wasm32-wasi`。

0.45.1 の `list-panes --all --json` で安定 pane_id (`terminal_N`/`plugin_N`) が CLI から取得可能なため、PoC 段階ではプラグインは不要。

### 結論

0.45.1 の CLI 拡充により、当初想定 (0.39 ベース) より多くの機能がプラグインなしで実現可能。プラグインが必要となるのは:

1. **リアルタイムイベント通知** (`changeEvents`) -- サイドバーの即時更新
2. **エージェント稼働状態の検知** (`agentState`) -- Tier 0 稼働検知

PoC の範囲ではプラグインは不要。本格採用時にはイベント通知のためにプラグインが有益。

## CLI リファレンス (0.45.1 実測)

### セッション

```bash
zellij list-sessions --no-formatting
# 出力例: azito [Created 5s ago]
#         old-session [EXITED]

zellij kill-session <session>
zellij delete-session --force <session>
```

### タブ

```bash
zellij --session <s> action query-tab-names
# 出力: 1 行 1 タブ名

zellij --session <s> action new-tab --name <n> --cwd <d>
# 出力: 作成されたタブの tab_id (数値)

zellij --session <s> action close-tab --tab-id <t>
zellij --session <s> action rename-tab --tab-id <t> <name>
zellij --session <s> action go-to-tab-name <name>
```

### ペイン

```bash
zellij --session <s> action list-panes --all --json
# 出力: JSON 配列。各要素に id, is_plugin, tab_id, tab_name,
#       pane_command, pane_cwd, is_focused, is_floating 等

zellij --session <s> action new-pane --direction <down|right> --tab-id <t> --no-focus
# 出力: 作成されたペインの pane_id (例: terminal_4)

zellij --session <s> action write-chars --pane-id <p> <text>
zellij --session <s> action write --pane-id <p> <bytes...>
zellij --session <s> action dump-screen --pane-id <p>
zellij --session <s> action close-pane --pane-id <p>
zellij --session <s> action rename-pane --pane-id <p> <name>
zellij --session <s> action focus-pane-id <p>
```

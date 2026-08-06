# tmux 設定ガイド

AZITO は tmux の上で動作するため、tmux 側の設定がいくつかの動作の前提になっています。
このガイドでは「必須設定」「推奨設定」「設定不要なもの（AZITO が自動設定するもの）」を区別して列挙します。

tmux 実行系統が **managed**（AZITO 管理の tmux、`~/.azito/tmux/`）の場合は、必須＋推奨の
全設定を含む `azito.conf` が自動配置されるため、このガイドの設定作業は不要です。
managed は **Linux（x86_64 / aarch64）専用** です。tmux 3.6b のスタティックバイナリを
GitHub から取得し、SHA256 固定検証付きでインストールします。macOS では managed は利用できず、
system モードのみとなります。
**system**（既存インストール済み tmux）の場合は、サーバー詳細パネルの
「Apply recommended config」ボタンで `~/.azito/tmux/azito.conf` に AZITO 設定を配置し、
`~/.tmux.conf` に `source-file` 行を1行追記します（既存の行は書き換えません）。

## 必須設定（これが無いと動作しない）

```tmux
set -g base-index 1
set -g pane-base-index 1
```

- **`pane-base-index 1`**: AZITO はペインを `<セッション>:<ウィンドウ>.1` 形式で参照します
  （エージェント起動の send-keys、pipe-pane、respawn 等）。tmux デフォルトの pane index は
  0 始まりのため、この設定が無いと `can't find pane: 1` でエージェントが起動しません。
- **`base-index 1`**: ウィンドウ参照は名前ベースのため直接の依存はありませんが、
  pane-base-index と揃えて 1 始まりにしておきます（`azito.conf` にも両方含まれています）。

> 補足: ペイン参照を index 非依存の pane ID に統一する改善が Issue #357 で予定されています。
> 完了後この設定は「推奨」に格下げされますが、それまでは必須です。

## 推奨設定（快適・正確な動作のため）

```tmux
set -s escape-time 10
set -g focus-events on
set -g history-limit 50000
set -g mouse on
```

- **`escape-time 10`**: Esc キーの待ち時間短縮。Claude Code 等の TUI エージェントの
  キー応答が体感で改善します（デフォルト 500ms）。
- **`focus-events on`**: 端末のフォーカスイベントをアプリケーションに伝えます。
  Claude Code や vim がフォーカス検知を利用します。
- **`history-limit 50000`**: スクロールバック行数。タスク出力の追跡やペイン内容の取得が長い出力でも欠落しにくくなります（デフォルト 2000）。
- **`mouse on`**: ブラウザターミナルのホイール・タッチスクロールが tmux のスクロールとして
  機能するために推奨します。

## 設定不要なもの（AZITO が実行時に自動設定）

以下は `.tmux.conf` に書く必要はありません。AZITO がプログラム側で設定します。

- **tmux hooks**（`set-hook -g` によるウィンドウ/セッション変更の検知）
- **リンクセッションの `status off`**（ブラウザタブごとの独立ウィンドウ選択用セッション）
- **`window-status-format`**（タスクウィンドウの表示形式）
- **pipe-pane**（タスク出力のストリーミング）

## 干渉に注意が必要な設定

- **`allow-rename`**: デフォルト（off）のままにしてください。AZITO はウィンドウを
  名前（`win--xxxx` 等の一意ラベル）で参照するため、プログラムのエスケープシーケンスで
  ウィンドウ名が書き換わると参照が壊れます。
- **`renumber-windows`**: 有効でも問題ありません（ウィンドウ参照は index ではなく名前のため）。
- **prefix キー変更・キーバインド・ステータスライン装飾・プラグイン（TPM 等）**:
  AZITO の動作には影響しません。自由に設定できます。

## モード別の適用方法まとめ

| モード | 適用方法 |
|---|---|
| managed | 不要（`~/.azito/tmux/azito.conf` に全設定が自動配置され、`-f` で読み込まれる） |
| system | サーバー詳細パネル → Dependencies → tmux 行の「Apply recommended config」（`~/.tmux.conf` に source-file 行を冪等追記）。手動の場合は上記スニペットを `~/.tmux.conf` に記載 |

設定変更後は tmux サーバーの再起動（`tmux kill-server`）または既存セッションでの
`tmux source-file ~/.tmux.conf` が必要です。ただし `base-index` / `pane-base-index` は
**既存のウィンドウ・ペインには遡及しない**ため、確実に反映するには tmux サーバーの
再起動を推奨します。

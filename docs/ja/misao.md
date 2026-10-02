# misao 実行系統（実験的）

misao（操）は、AI コーディングエージェント向けのヘッドレスなペインサーバーです。tmux の代わりに、
local サーバーのウィンドウとペインを misao デーモンへ任せられます。**実験的機能**であり、
`AZITO_EXPERIMENTAL_MISAO=1` のときだけ有効です。フラグがオフのハブでは、API・画面・挙動は
これまでと一切変わりません。

対象は **local サーバーだけ**です（agent / SSH サーバーでは選べません）。

## 有効化の手順

### 1. misao をインストールして起動する

misao は別リポジトリ（[wireframeslayout/misao](https://github.com/wireframeslayout/misao)）です。
Node.js 24 以上が必要です。ビルドして `misao` を PATH に置き、デーモンを起動します。

```bash
git clone https://github.com/wireframeslayout/misao.git
cd misao
npm ci && npm run build
mkdir -p ~/.local/bin && ln -sf "$PWD/packages/cli/dist/main.js" ~/.local/bin/misao
misao serve            # フォアグラウンド起動。常駐させるなら systemd ユーザーユニットを使う
```

常駐化（`systemctl --user enable --now misao.service`）の手順は misao 側の
[deploy/README.md](https://github.com/wireframeslayout/misao/blob/main/deploy/README.md) を参照してください。
起動できているかは端末から確認できます。

```bash
misao status
```

### 2. ハブをフラグ付きで起動する

ハブの環境変数に `AZITO_EXPERIMENTAL_MISAO=1` を足して再起動します。

| 起動方法 | 設定場所 |
|---|---|
| ソース版（`npm run dev`） | `packages/server/.env` |
| リリース版（systemd / launchd） | `~/.azito/hub/.env` |

```bash
echo 'AZITO_EXPERIMENTAL_MISAO=1' >> packages/server/.env
```

ハブは既定で `~/.misao/misao.sock` に接続します。別のソケットを使うデーモンへ繋ぐときは、
**ハブの環境**に `MISAO_SOCKET=<ソケットの絶対パス>` を設定します（ソケットパスは 107 バイト以内）。
ハブと `misao` コマンドで同じソケットを見ている必要があります。

### 3. サーバー設定で切り替える

1. Servers から `local` サーバーを開き、概要の「編集」を押します。
2. 「tmux ランタイム」で **misao（実験的）** を選んで保存します。
3. 概要の「mux runtime」が `misao（実験的）` になり、接続状態のチップが「接続中」になれば完了です。

tmux 上にあるウィンドウは misao へ移行されません。切り替え後に作ったウィンドウから misao の
ペインになります。元に戻すときも同じ画面で system / managed を選びます。

## 接続できないとき

概要に「misao に接続できません。端末からは misao status で確認できます」と出る場合、ハブが
デーモンに接続できていません。

- `misao status` でデーモンが動いているか確認します。
- ハブの環境の `MISAO_SOCKET`（未設定なら `~/.misao/misao.sock`）が、デーモンのソケットと一致しているか確認します。
- デーモンが復帰すると、ハブは自動で再接続します。

「この runtime は AZITO_EXPERIMENTAL_MISAO=1 のときだけ使えます」と出る場合は、フラグがオフのハブで
misao のサーバーを開いています。フラグを有効にするか、編集から runtime を system / managed に戻してください。

## できること・制約

- ブラウザ端末の attach、ウィンドウ・ペインの作成と操作、タスク実行（worktree 上のウィンドウでエージェントを駆動）、
  稼働検知に対応します。
- 稼働検知はデーモンの `pane.state` イベントを使います（`GET /api/debug/activity` では `tier0_mux`）。
  tui-supervisor は使いません。misao の `idle` は完了の証拠として扱わないため、完了行（「完了 ·」）が出るのは
  エージェントのプロセスが終了したときです。詳細は [稼働検知 Tier 判定リファレンス](./activity-detection.md) の「misao 窓」を参照してください。
- ペインのズーム、レイアウトの保存・適用、ペインタイトルの設定などの tmux 固有の操作は未対応です。
- デーモンを再起動するとペインのプロセスは失われます（メタデータだけが残り、`stopped` になります）。
- agent / SSH サーバーでの misao、Add Server 画面での選択、managed tmux の導入導線は対象外です。

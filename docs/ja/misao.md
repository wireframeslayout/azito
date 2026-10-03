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

## 停止中のペインと空のウィンドウ

- デーモンを再起動すると、既存のペインは `stopped`（プロセスが無い状態）で復元されます。サーバー詳細のウィンドウ一覧では
  そのペインが減光され、「停止中」のチップが付きます。プロセスが終了しただけのペインは「終了」のチップです。
  デーモンの状態を報告しない tmux のペインにはどちらも付きません。
- ウィンドウを開くと、生きているペイン（最初の `running`）に接続します。生きているペインが無ければ先頭のペインを開きます。
- `stopped` のペインは attach できません。明示的に開いたときは、ターミナルの WebSocket がクローズコード **4410**
  （reason `pane stopped`）で閉じ、再接続は行いません。画面には「このペインは停止しています」と［ペインを削除］が出ます。
  一覧の行にある削除ボタンからも同じペインを削除できます（`DELETE .../panes/:ordinal`、デーモンの `pane.close`）。
  `exited` のペインは従来どおり attach できます（画面の最後の状態が見えます）。
- 最後のペインを閉じてもウィンドウは自動では消えず、ペインが 0 個の「空のウィンドウ」になります。一覧には「ペインがありません」と
  ［ペインを開く］［ウィンドウを削除］が出ます。空のウィンドウに接続すると WebSocket はクローズコード **4412**
  （reason `window empty`）で閉じ、画面に同じ案内が出ます。［ペインを開く］は起動コマンド（シェルのみ / 各エージェント /
  カスタム）を選べ、`POST /api/servers/:name/mux/windows/:ref/panes/open`（body `{ "command"?: string }`）でシェルのペインを開いてから
  コマンドを送ります。
- ウィンドウが存在しないときのクローズコードは従来どおり **4404**（`window not found`）で、上の 2 つとは別扱いです。
- misao のウィンドウのラベルはウィンドウ名だけです（tmux は `セッション:ウィンドウ名` のまま）。

## できること・制約

- ブラウザ端末の attach、ウィンドウ・ペインの作成と操作、タスク実行（worktree 上のウィンドウでエージェントを駆動）、
  稼働検知に対応します。
- 稼働検知はデーモンの `pane.state` イベントを使います（`GET /api/debug/activity` では `tier0_mux`）。
  tui-supervisor は使いません。misao の `idle` は完了の証拠として扱わないため、完了行（「完了 ·」）が出るのは
  エージェントのプロセスが終了したときです。詳細は [稼働検知 Tier 判定リファレンス](./activity-detection.md) の「misao 窓」を参照してください。
- ペインのズーム、レイアウトの保存・適用、ペインタイトルの設定などの tmux 固有の操作は未対応です。
- デーモンを再起動するとペインのプロセスは失われます（メタデータだけが残り、`stopped` になります）。
- agent / SSH サーバーでの misao、Add Server 画面での選択、managed tmux の導入導線は対象外です。

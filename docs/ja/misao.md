# misao 実行系統

misao（操）は、AI コーディングエージェント向けのヘッドレスなペインサーバーです。tmux の代わりに、
local サーバーのウィンドウとペインを misao デーモンへ任せられます。ハブは misao ドライバを常に登録し、
サーバーごとの「既定のターミナル方式」（misao / tmux）で使い分けます。デーモンが無い環境でもハブは起動し、
そのサーバーは「接続できません」として扱われます。

対象は **local サーバーだけ**です（agent / SSH サーバーでは選べません）。

## 使い始める手順

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

### 2. ハブの接続先を確認する

ハブは既定で `~/.misao/misao.sock` に接続します。別のソケットを使うデーモンへ繋ぐときは、
**ハブの環境**に `MISAO_SOCKET=<ソケットの絶対パス>` を設定します（ソケットパスは 107 バイト以内）。
ハブと `misao` コマンドで同じソケットを見ている必要があります。設定場所は、ソース版（`npm run dev`）なら
`packages/server/.env`、リリース版（systemd / launchd）なら `~/.azito/hub/.env` です。

### 3. サーバー設定で切り替える

1. Servers から `local` サーバーを開き、概要の「編集」を押します。
2. 「既定のターミナル方式」で **misao** を選んで保存します（「tmux の実行ファイル」は tmux を使うときの設定で、システム / 管理版を選びます）。
3. 概要の「既定のターミナル方式」が `misao` になり、接続状態のチップが「接続中」になれば完了です。

「既定のターミナル方式」は、新しく作るウィンドウの置き場所です。local サーバーは tmux と misao の
両方のウィンドウを同時に扱えます。tmux 上にあるウィンドウは misao へ移行されず、そのまま tmux の
ウィンドウとして使い続けられます（稼働検知・端末・タスクの follow-up も、ウィンドウごとに自分の方式で動きます）。
元に戻すときも同じ画面で「既定のターミナル方式」に tmux を選びます。

## 1 台のサーバーで tmux と misao を併用する

- ウィンドウ・ペインの操作は、ウィンドウの `mux_ref` の種別（ペインはハンドルの形。misao は `p_<ULID>`）で
  tmux / misao に振り分けられます。サーバーの既定の方式は、新しく作るウィンドウにだけ効きます。
- `GET /api/servers/:name/sessions` は両方の一覧を併せて返し、各セッションに `kind`（`"tmux"` / `"misao"`）を付けます。
  同じ名前のセッションが両方にあっても、`kind` で区別されます。
- `?detail=1` を付けると `{ sessions, unavailable }` を返します。`unavailable` は、そのサーバーが扱える方式のうち
  一覧できなかったもの（例: `{ "kind": "misao", "reason": "daemon_unreachable" }`）です。デーモンが止まっていても
  もう一方の方式のセッションは返り、止まっている方式のウィンドウは「削除された」扱いになりません
  （画面のタブは閉じられず、稼働検知も完了を出しません）。両方とも一覧できないときはエラーになります。
- `POST /api/servers/:name/mux/workspaces` などのワークスペース操作は `kind` を受け付けます（省略時は既定の方式）。
- misao のウィンドウの `tmux_target` は `<workspace>:<window id>` の形で保存されます（migration 078 で既存の行も変換）。

API では `PUT /api/servers/:name` の `defaultMux`（`"misao"` / `"tmux"`、misao は local サーバーのみ）と `muxRuntime`（`"system"` / `"managed"`、tmux の実行ファイル）を別々に指定します。
以前の `muxRuntime: "misao"` は `defaultMux: "misao"` として今のところ受け付けますが、互換のためで、次のリリースで廃止する予定です。

## 接続できないとき

概要に「misao に接続できません。端末からは misao status で確認できます」と出る場合、ハブが
デーモンに接続できていません。

- `misao status` でデーモンが動いているか確認します。
- ハブの環境の `MISAO_SOCKET`（未設定なら `~/.misao/misao.sock`）が、デーモンのソケットと一致しているか確認します。
- デーモンが復帰すると、ハブは自動で再接続します。

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
  tui-supervisor は使いません。misao の `idle` 単体は完了の証拠として扱いませんが、Claude の Stop hook が
  届いていれば完了行（「完了 ·」）が出ます（`refinedBy: tier1_hook_stop`）。hook の無いエージェント（codex 等）では
  プロセスが終了したときだけ出ます。詳細は [稼働検知 Tier 判定リファレンス](./activity-detection.md) の「misao 窓」を参照してください。
- ペインのズーム、レイアウトの保存・適用、ペインタイトルの設定などの tmux 固有の操作は未対応です。
- デーモンを再起動するとペインのプロセスは失われます（メタデータだけが残り、`stopped` になります）。
- agent / SSH サーバーでの misao、Add Server 画面での選択、managed tmux の導入導線は対象外です。ウィンドウ追加の画面で
  方式を選ぶ機能は今後の対応です（今は既定の方式に作られます）。

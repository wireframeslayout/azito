# misao 実行系統

misao（操）は、AI コーディングエージェント向けのヘッドレスなペインサーバーです。tmux の代わりに、
local サーバーのウィンドウとペインを misao デーモンへ任せられます。ハブは misao ドライバを常に登録し、
サーバーごとの「既定のターミナル方式」（misao / tmux）で使い分けます。デーモンが無い環境でもハブは起動し、
そのサーバーは「接続できません」として扱われます。

対象は local サーバーと agent サーバーです（[エージェントサーバー](#エージェントサーバー) を参照）。SSH サーバーでは選べません。

## 使い始める手順

### リリース版（install.sh）

リリース版は misao を**同梱**しています。`install.sh` が `azito-misao` サービス（systemd / launchd）として設置・起動し、
ハブの `.env` に `MISAO_SOCKET` を書くので、手動の準備は要りません。tmux は任意です（無くても使えます）。
新規インストールの local サーバーは、既定のターミナル方式が misao になります。

- 状態の確認: `azito misao status`、または Servers → 対象サーバー → Setup の misao 行。
- **既存のインストール**（misao 同梱前に入れた環境）: `azito misao install`、または Setup の「misao をインストール」で設置します。
  `.env` を書き換えるので、その後にハブを再起動してください（ペインは終了しません）。
- **更新**: ハブを更新しても misao は更新・再起動されません（再起動するとペインがすべて終了するため）。同梱版と稼働中の版が違うときは
  Setup の misao 行に表示が出ます。`azito misao update`、または「misao を更新（実行中のペインは終了します）」で、利用者が明示的に切り替えます。
  0.2.0（Node 版）が入っている環境も同じ操作で 0.3.0（ネイティブバイナリ）へ切り替わります。unit は更新時に作り直され（`__NODE__` が無くなる）、旧版のディレクトリはそのまま残り、失敗したときは更新前の unit と版に戻します。
- tmux が無いホストでは、窓追加の「ターミナル方式」で tmux が選べず（理由つきで disabled）、Setup の tmux 行は「任意」と表示されます。

サービスの構成・コマンド・手動設置は [インストールとアップデート](./install-and-update.md#misao-サービス) を参照してください。

### ソース版（npm run dev）・手動管理

ソース版（`npm run dev`）はサービスを入れません。次の手順で自分で misao を用意し、`MISAO_SOCKET`（未設定なら既定のソケット）で接続します。
リリース版でも、別のデーモンへ繋ぎたいときは同じ設定になります。

### 1. misao をインストールして起動する

misao は別リポジトリ（[wireframeslayout/misao](https://github.com/wireframeslayout/misao)）です。
単一のネイティブバイナリで、Node.js は要りません。[Releases](https://github.com/wireframeslayout/misao/releases) から
OS / アーキテクチャに合うアーカイブ（`misao-<version>-<target>.tar.gz`。target は `x86_64-unknown-linux-musl`・
`aarch64-unknown-linux-musl`・`aarch64-apple-darwin`・`x86_64-apple-darwin`）を取得し、`misao` を PATH に置いてデーモンを起動します。

```bash
tar xzf misao-0.3.0-x86_64-unknown-linux-musl.tar.gz
mkdir -p ~/.local/bin && install -m 755 misao-0.3.0-x86_64-unknown-linux-musl/misao ~/.local/bin/misao
misao serve            # フォアグラウンド起動。常駐させるなら systemd ユーザーユニットを使う
```

常駐化（`systemctl --user enable --now misao.service`）の手順は misao 側の
[deploy/README.md](https://github.com/wireframeslayout/misao/blob/main/deploy/README.md) を参照してください。
起動できているかは端末から確認できます。

```bash
misao status
```

### 2. ハブの接続先を確認する

ハブは既定で `~/.misao/misao.sock` に接続します（リリース版は install.sh が `~/.azito/misao/misao.sock` を `.env` に書きます）。別のソケットを使うデーモンへ繋ぐときは、
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

API では `PUT /api/servers/:name` の `defaultMux`（`"misao"` / `"tmux"`。エージェントサーバーでも、misao が導入済みで接続できれば使えます）と `muxRuntime`（`"system"` / `"managed"`、tmux の実行ファイル）を別々に指定します。
以前の `muxRuntime: "misao"` は `defaultMux: "misao"` として今のところ受け付けますが、互換のためで、次のリリースで廃止する予定です。

## エージェントサーバー

エージェントサーバーでも misao を使えます。ハブは**サーバーごとに misao への接続を 1 本**持ちます。local サーバーはハブ自身のデーモン、
エージェントサーバーはそのホストのデーモンに、エージェント経由でつなぎます。

- **中継**: エージェントは `/ws?mode=misao`（WebSocket とエージェント自身の misao ソケットのバイト中継。ソケットはエージェントの環境の
  `MISAO_SOCKET`、無ければ `~/.azito/misao/misao.sock`）を持ちます。ハブの SDK はこの上でプロトコルを話すので（`MisaoClient({ connect })`）、
  ウィンドウ・端末・タスクの出力行・稼働検知は local サーバーと同じように動きます。
- **セキュリティ**: 中継はデーモンの全権（エージェントのユーザーとして任意のコマンドを実行できる）を渡すため、`/api/exec` と同じ守り方です。
  エージェントトークンと、エージェントの bind 制限（Tailscale IP。`0.0.0.0` は不可）です。ソケットはエージェントが起動時に固定し、
  リクエスト（パスやクエリ）で別のソケットを指すことはできません。同時に開ける中継は 128 本までです。
- **タスク出力**: 行の購読はそのサーバー自身の接続で行い、完了シグナルのファイルはエージェントのホストにあるため、tmux と同じく
  エージェントの file-tail で読みます。
- **一覧**: エージェントサーバーに misao が出るのは、導入済みの場合だけです（既定の mux、misao の窓の記録、エージェントが報告するデーモンのソケット）。
  入っていないサーバーには `unavailable` の misao が出ません。そこで misao の窓を作ろうとすると `409 mux_kind_unavailable`（reason `not_installed`）です。
- **隔離**: 隔離が有効なサーバーの misao 窓にも、tmux と同じ資格情報のマスク（`composePaneEnv`）がかかります。デーモンが継承した値に
  関わらず、`AZITO_UI_TOKEN`・`AZITO_AGENT_TOKEN`・`AZITO_WEBHOOK_TOKEN` は空になります。ハブの webhook トークンは一時 env で渡すので、
  デーモンには保存されません。

### エージェントサーバーへの misao の導入

ハブは**同梱の misao**をエージェント経由で送ります（リリースのファイルは、マニフェストの sha256 と両端で照合します。エージェントは何も
ダウンロードしません）。どのハブも Unix の 4 ターゲットと `x86_64-pc-windows-msvc`（`misao.exe`）の計 5 ターゲットのバイナリを持ち（ハブ自身も同じ同梱物から自分の misao を入れます。ハブは
Linux x86_64 / arm64 と macOS arm64 で動きます）、エージェント自身の OS / アーキテクチャ（Linux x86_64 / arm64、
macOS arm64 / x86_64）に合うものを送ります。合うものが無いホストはエラーで断ります（フォールバックはしません）。
ただし、このリリースのエージェントの自動インストールは x86_64 のホストしか受け付けないため、arm64 のエージェントサーバーは未対応です
（同梱するバイナリとは別の話です）。
`~/.azito/misao/<version>/` に、`current` -> `<version>` で配置し、systemd のユーザー unit `azito-misao`（`KillMode=process`）として起動します。
ユーザー systemd が無いホスト（macOS では常に）では、環境を空にしたバックグラウンドプロセスで起動します（再起動をまたいでは残りません）。
Node.js も node-pty も使いません。Windows のハブへの導入は、下の「Windows のハブ自身の misao」の節です。リリースのビルドにはこの zip を展開する `unzip` コマンドが必要です。Windows のエージェントへの導入は次の節です。

#### Windows のエージェントへの導入

Windows のエージェント（`x86_64-pc-windows-msvc`）には、同じくエージェント経由（`PUT /api/misao/upload`。ファイル名は `misao.exe`）で送り、sha256 を両端で照合して
`%USERPROFILE%\.azito\misao\<version>\` に置きます。シンボリックリンクは使わず、現在の版は **`<root>\current`（版を書いたファイル）** と、**タスクの定義に書いた `misao.exe` の絶対パス**で表します。
`<root>` は所有者だけのフォルダーにします（A2 と同じ ACL の仕組み）。ホスト上の作業は、エージェントの `/api/run` で動かす PowerShell（`-EncodedCommand`）と `schtasks.exe`、
ファイル API だけです（sh は使いません）。

- **常駐**は、タスクスケジューラのタスク `AzitoMisao`（ログオン時に起動）です。実行内容は `conhost.exe --headless cmd.exe /d /c ""<root>\<version>\misao.exe" serve --socket "<pipe>" --data "<root>" >> "<root>\misao.log" 2>&1"`
  で、窓が出ず、ログ（misao 自身にはログのファイルを指定する引数が無い）は `cmd.exe` が追記します。作業ディレクトリはユーザーのホームフォルダーです（ペインがリリースのフォルダー内で始まって削除を妨げないように）。**パスに ASCII の英数字と `. _ : ~ \ -` 以外の文字を含むフォルダー**（空白・括弧・`&`・`%`・`!`、日本語のユーザー名など）は、このコマンドラインに書けません（`conhost.exe` が読み直し、引用符の付け方によらずタスクが何も起動しなくなります）。その場合のタスクは、固定の PowerShell 起動スクリプト（`conhost.exe --headless powershell.exe -EncodedCommand ...`）が同じ `cmd.exe` の行をパスを環境変数に入れて起動するため、パスがコマンドラインに載りません。通常の文字だけのフォルダーは上の形のままです。パイプ名はフォルダーの実際の綴り（`RUNNER~1` のような 8.3 短縮名とジャンクションを `resolveRealPath` で解決する。存在する最も近い祖先を解決し、未作成の部分はそのまま結合するので、フォルダーの作成前後で結果が変わらない）から決めます。解決は、そのフォルダーを持つホストが入口で 1 回だけ行います（ハブは自分の prefix、agent は自分の home。agent は解決済みの `misaoRoot` を報告する）。`windowsMisaoPipe`・タスクの定義・所有先の検査は文字列を比べるだけで、ハブが agent のパスを自分のファイルシステムで調べることはありません。所有先の検査は、XML の文中ではなく、タスクが起動するフォルダー（`--data`、または起動スクリプトの `AZITO_MISAO_ROOT`）を取り出し、解決済みの root と比べます。短縮表記から作ったパイプで daemon が動いている agent は、これで止まりません（install / update は動いているタスクを見て `daemon_not_ready` で何も変えずに断り、次の停止と更新で実際の綴りのパイプに移ります）。
  タスクの RestartOnFailure は発火しません（`conhost.exe --headless` は daemon に何があっても終了コード 0 を返し、タスクスケジューラは非 0 の終了コードでもタスクを再起動しないため。Windows CI での実測）。そのため**ハブが起動し直します**。ハブは動いている間、Windows の agent を 15 秒ごとに見て、agent には届くのに AZITO が導入した daemon が応答しなければ、約 1 分後に agent 経由でタスクを起動し直し（`schtasks /Run`）、以降は 15 分を上限に間隔を倍々に延ばします（2 回目以降は、「実行中」のままで daemon がいないタスクを先に終了させます）。ハブが止まっている間は戻りません。手で止めた（`misao stop`、`schtasks /End`）ものは落ちたものと区別できないので、やはり起動し直されます。止めたままにするには、サーバーをハブから外すか、タスクを無効にしてください（`schtasks /Change /TN AzitoMisao /DISABLE`。無効のタスクはハブが黙って飛ばします）。ハブが触るのは管理している daemon だけです。別のパイプ（`MISAO_SOCKET`）を中継している agent、AZITO が導入していない misao、別のフォルダーの misao を起動するタスクには触れません（警告を 1 回だけ出します）。ログオフ中はタスクが動かないので、デーモンも動きません。
- **接続口**は名前付きパイプ `\\.\pipe\misao-<ユーザー>-<sha256(<root> の小文字)の先頭 16 桁>` です（`MISAO_DIR=<root>` のときに SDK の `resolveSocketPath` が返す名前と同じ。テストが照合します）。
  エージェントは起動時に 1 回だけこれを決め、`MISAO_SOCKET` にパイプの名前が入っていればそれを使います。リレー（`/ws?mode=misao`）と `GET /api/misao/status` / `PUT /api/misao/upload` は Windows でも有効です。
  `socketPresent` は「パイプに接続できる」で、パイプはサーバーの終了とともに消えるので「デーモンが動いている」と同じです。
- `install()` の約束は Unix と同じです。**動いているデーモンを止めも切り替えもしません**（古い版が動いていれば新しい版を横に置くだけで、`updateAvailable` で伝えます。AZITO が入れたものではないデーモンは断ります）。何も動いていなければ起動します。
- `update()`（`POST /api/servers/:name/update-misao`）は、前の版の `misao.exe stop`（パイプ経由。デーモンはペインを閉じてから終了コード 0 で終わります）→ `current` とタスクの切り替え → 起動、の順です。
  止まらなければ、タスクの End と、`--socket <パイプ>` を引数に持つこのユーザーの `misao.exe` の掃除を行い、それでも止まらなければ何も変えずに失敗します。切り替えで失敗したら、前の `current` とタスクの定義を戻し、前の版を起動します（Unix と同じ約束）。
- **ペイン**は、エージェントが報告する `%ComSpec%`（cmd.exe。misao 自身の既定と同じ）で、コマンドを付けずに開きます。ワーカーの起動行（claude / codex）を載せた窓は #371 の範囲で、今は `unsupported_os` です。
- 試験用に、タスク名とフォルダーは環境変数 `AZITO_WIN_MISAO_TASK_NAME` / `AZITO_WIN_MISAO_DIR`（ハブ側。A2 の `AZITO_WIN_AGENT_*` と同じ仕組み）で変えられます。フォルダーはエージェントの設定ファイルの `AZITO_MISAO_DIR` に書かれます（既定以外のときだけ）。
- ログイン中のユーザーが居ないホスト（ログオンセッションが無い）では、タスクが起動せず（最後の結果が `0x8004130f`）、導入は `daemon_not_ready` で失敗して、作ったタスクと `current` を取り除きます。

#### Windows のハブ自身の misao

Windows のハブは、自分の misao を**エージェントと同じ導入処理**（`MisaoWindowsInstaller`）で入れます。違いは対象だけで、自分のマシンを相手にします（`misaoLocalWindows.ts`。コマンド・ファイル・パイプの確認・配置を、エージェント経由ではなくプロセス内で行う）。配置・タスク・停止 / 切り替え / 起動 / 巻き戻しの手順の定義が 1 つになり、上の約束はそのまま成り立ちます。install は動いているデーモンを止めも切り替えもせず、update は `misao.exe stop` で止めて切り替えて起動し、失敗したら前のリリースに戻します。ハブの更新・再起動・`azito stop` はデーモンに触れません。

- **1 ユーザーにつき 1 つの misao。** 置き場所は `<prefix>\misao`（既定の prefix `%USERPROFILE%\.azito` なら `%USERPROFILE%\.azito\misao\<version>\misao.exe` とライセンス）、タスクは `AzitoMisao`、リリースはファイル `<root>\current`、パイプはそのフォルダのもの（`\\.\pipe\misao-<user>-<フォルダのハッシュ>`）です。同じマシンの Windows エージェントも同じフォルダ・タスク・パイプを使うので、タスク名を奪い合わず、デーモンは 1 つになります。**別のフォルダ**の misao を起動するタスク（別の prefix、別の導入）がある場合は install・update・start で拒否し、`azito misao install --replace-socket` で意図して引き継げます。
- **ハブ自身の misao が落ちたとき（Windows）。** 理由は agent の misao と同じで（`conhost.exe --headless` が終了コード 0 を返し、タスクを再起動する者がいない）、対処も同じものをこのマシンに向けています。ハブが動いている間、`LocalMisaoWatchdog` が 15 秒ごとに見て、`azito misao install` が導入した daemon（ハブの `MISAO_SOCKET` が管理しているパイプで、タスクがこのフォルダーの misao を起動する）が応答しなければ、約 1 分後にそのタスクを起動し直し、以降は 15 分を上限に間隔を倍々に延ばします（2 回目以降は、「実行中」のままで daemon がいないタスクを先に終了させます）。`azito misao install|start|update` と Setup 行の更新と同じ「同時に 1 つ」の枠を**プロセスをまたいで**使います（CLI は別プロセスで動くため）。枠は misao のフォルダーから作る Windows の名前付きパイプ（`\\.\pipe\azito-lock-<フォルダーと秘密鍵のハッシュ>`。鍵は `<prefix>\misao\.lock-key` にある 32 バイトの乱数で、秘密ファイルのガード経由で一度だけ作られ、本人だけが読めます。名前付きパイプはどのユーザーでも作れるため、フォルダー名だけで決まる名前だと別のユーザーが先に作って見張りの復旧を妨げられますが、鍵が無ければ他人は名前を割り出せません。鍵のファイルが本人専用でない、または鍵でないときは、鍵なしに戻さず、理由付きでその操作を失敗させます。誰が持っているかを尋ねて読まずに居座る接続は、2 秒後と解放時に切るので、解放を止められません）で、そこで listen している間がロック中です。2 つ目の listen は拒否され、持ち主がどう終わっても OS が解放するので、古いロックを判定する必要がありません。ハブが**Windows の agent 経由**で行う install / update / revive も、その agent が報告する misao のフォルダーがハブ自身のものと完全に同じ（同じマシンの同じユーザーで、同じ daemon を共有する agent）なら同じ枠を取るので、同居の agent の更新の最中にも見張りは daemon に触れません。一致の判定はフォルダーの名前だけです。別のマシンの agent がたまたま同じパス（同じユーザー名と prefix）を報告すると不要に直列化されますが、誤って素通しすることはありません。フォルダーが違う agent は、従来どおりサーバー名ごとの mutex だけです。別のプロセスが持っている間、見張りは何もせず次の周期で見直すので、更新に割り込むことはありません。`azito misao install|start|update` は取れなければ、持ち主のプロセス ID を示してすぐ止まります（待ちません。更新はすべてのペインを閉じるので、やり直すかどうかは利用者が決めます）。この排他を掛けるのは Windows のハブの misao だけです。Linux と macOS（systemd / launchd）ではデーモンを勝手に起動する者がいないので、見張りと競合せず、CLI とハブは従来のままです。手で別の daemon に向けた `MISAO_SOCKET`、別の prefix の misao を起動するタスク、手で無効にしたタスク（`schtasks /Change /TN AzitoMisao /DISABLE`）には触れません。**限界:** ハブが止まっている間は misao も戻りません。ハブは自分のランチャーで戻り（`install-and-update.md`）、そのあとに misao を戻します。
- **prefix。** 空白・括弧・`&`・`%`・`!` は使えます（`C:\Users\Foo Bar (Work)\.azito`。このときタスクは上で説明した起動スクリプトを経由します）。引用符と改行は拒否します。Unix の検査は変えていません。パイプには unix ソケットの 107 バイトのような長さ制限はありません。
- **接続。** `azito misao install` は、デーモンが応答したあとに `<prefix>\hub\.env` へ `MISAO_SOCKET=<パイプ>` を書きます。`run.ps1` がハブの起動前にこのファイルを読むので、ハブは `.env` からパイプを決めます（SDK の既定は別のフォルダのパイプになります）。動いているハブが別のものを使っている間、`GET /api/system/misao` は `needsHubRestart` を返します。新しい DB では、`MISAO_SOCKET` があるか `AzitoMisao` タスクが登録済みなら、local サーバーの既定が misao になります（`hasMisaoToRelyOn`）。
- **コマンド。** `azito misao status|install|update|start` と Setup 行のボタン（`GET/POST /api/system/misao...`）は Unix と同じに動きます。`serviceManager` は `taskscheduler` で、Windows に systemd / launchd の unit を書く経路はありません。`install.ps1` は、ハブのタスクの登録後に `azito misao install --prefix <prefix>` を呼びます（`-NoService` のときは呼びません。`install.sh` が `--no-service` で呼ばないのと同じ）。失敗は警告で、`azito misao install` で繰り返せます。
- **local サーバーは misao だけ**（#380 B4a）。Windows ホストの tmux を閉じる判断は `hostFeatureSupport(profile, 'tmux')` の 1 か所で、サーバー側もそれを読みます。`SqliteServerRepository` はハブ自身のホストを local サーバーの `hostProfile` として読み出し時に付け（保存はしない）、保存済みの既定 `tmux` もそこでは `misao` として読みます（行は書き換えません）。`supportedMuxKinds` は misao だけを返し、tmux ドライバは `registerTmuxDriver` で登録します（Windows ホストでは `hosted` にならず、呼ぶと `unsupported_os`。`POST .../mux/workspaces {kind:'tmux'}` は理由付きの 409 `mux_kind_unavailable`）。`LocalTransport.execMux` / `openTerminal` に紛れ込んだ tmux 呼び出しも同じ理由で断ります。起動時に info を 1 行出すだけで、エラーの連続にはしないもの: `TmuxHookManager` の hook、起動時のリンクセッション掃除、`install-status` の tmux の行、`install-tmux`（501 `unsupported_os`）、`defaultMux: tmux` への `PUT`（501）。misao の窓に tui-supervisor は使いません。tier 2 / 3 / 4 の tmux の capture は tmux の窓だけが対象で、Windows のハブにはありません。Unix のハブは変わりません（tmux と misao の同居）。
- **ペイン。** Windows のハブ自身の misao のペインのシェルは `%ComSpec%`（cmd.exe）で、コマンドを付けずに開きます（`hubPaneShell`、`commandArgs: null`。Windows の agent と同じ）。窓の作成・名前変更・削除、`send-keys`、`capture`、ブラウザの端末 WebSocket への接続（ConPTY は misao 側）が動きます。**ペインにコマンドを載せる起動**（ワーカー・タスク）は #371 まで `unsupported_os` です。ワーカーの行をペインに打ち込む経路はすべて閉じています。入口（窓・行・status を変える前）と、行を作る一番下の 1 か所の両方です。cd・起動・respawn・supervisor の wrap の行は `workerLineDialect`（`shared/os/hostFeature.ts`）だけを通って方言を得るので、入口で漏れた経路があっても cmd.exe には届きません。入口（`assertHostFeature`、501 `unsupported_os`。`hostFeatureSupport` の `workerLaunch` / `taskExecution`）: `POST /api/windows/:id/launch-agent`、`execute`、`followUp`（follow-up、`answer`、フィードバック付きの `approve-plan`）、`resumeStateMachine`（`approve-plan`、起動時の復旧、承認）、`WindowRespawnService.respawn`（`POST /api/windows/:id/respawn`、`recover-session`。単一・複数ペイン）と `resumeLegacySession`、`TaskRestoreService.restore`。`answer` と `approve-plan` は status を変えてから結果を待たずに実行するので、先に `ExecuteTaskUseCase.assertCanLaunchWorker` で確かめます。コマンド行付きでペインを開く経路は `requireCommandArgs` が断ります。PowerShell のペインは #370 / #371 です。
- **稼働検知。** daemon の `pane.state` は Unix と同じく `tier0_mux` に届きます（`GET /api/debug/activity` に、Windows のハブの local サーバーで登録された agent 窓が出ます）。Windows CI（`smoke-misao-win32.ts`）が実物の `misao.exe` で、作成・名前変更・send-keys・capture・端末の 1 往復・診断の `tier0_mux`・ワーカーの拒否・削除を確かめます。

- エージェントサーバーの追加（自動インストール）では、エージェントのあとに misao を入れます。tmux が無いホストも preflight で止まらなくなり、
  その場合は既定の mux が misao になります。misao だけが失敗しても、エージェントは導入済みのまま、レスポンスの `misaoError` で伝えます。
- misao が入っていないサーバーで misao の窓を作ろうとすると、UI が確認してから `POST /api/servers/:name/install-misao` を呼びます
  （operator 限定。互換モードでも明示的に拒否します。同じパスの `GET` が進捗を返します）。サーバーのセットアップの misao 行にも同じボタンがあり、進捗とエラーが出ます。
- エージェントの更新（`AgentUpdater`）は、misao デーモンを止めも再起動もしません。同梱版と別の版が動いているときはそのままにし
  （セットアップの行がそう伝えます）、切り替えるとペインがすべて終了します。
- **エージェント側で稼働中のデーモン**（たとえば 0.2.0 の Node 版）を同梱版へ切り替えるのは明示的な操作です。セットアップの行の「misao を更新」ボタン
  （稼働中の版が同梱版と違うときだけ出ます。そのサーバーのペインがすべて終了するため、先に確認ダイアログが出ます）、または
  `POST /api/servers/:name/update-misao`（operator 限定。互換モードでも拒否します。進捗は同じ `GET`）です。更新前の `current` のリンクと unit ファイルを保存し、
  デーモンを止め（systemd の unit、`misao stop`、管理ソケットを名指しするコマンドラインのプロセスへの SIGTERM の順。バックグラウンドで起動したデーモンもここで止まります）、
  `current` と unit を切り替えて新しい版を起動し、ソケットが開くのを待ちます。どこかで失敗したら、保存しておいたリンクと unit を戻し、前の版を起動し直します。
  何も動いていないホストへの install も、リンクと unit は失敗時に戻します。
- 未対応: 起動時の滞留タスクの復旧（local サーバーのみ）。
- ソースチェックアウトのハブは misao を同梱していないため、エージェントサーバーへ導入できません。

## 接続できないとき

概要に「misao に接続できません。端末からは misao status で確認できます」と出る場合、ハブが
デーモンに接続できていません。

- `misao status` でデーモンが動いているか確認します。
- ハブの環境の `MISAO_SOCKET`（未設定なら `~/.misao/misao.sock`）が、デーモンのソケットと一致しているか確認します。
- リリース版は `azito misao status` で、サービスが動いているか・同梱版との差・ハブの再起動が要るかを確認できます。プロトコルが合わないときは「非互換」と出るので、`azito misao update` で同梱版へ切り替えます。
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
- SSH サーバーでの misao と、managed tmux の導入導線は対象外です。

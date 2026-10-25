# インストールとアップデート

## クイックインストール

### ワンライナー

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/wireframeslayout/azito/releases/latest/download/install.sh | bash
```

オプションを渡す場合:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/wireframeslayout/azito/releases/latest/download/install.sh | bash -s -- --version v0.3.0 --no-service
```

Windows（Windows PowerShell 5.1、管理者権限は不要。先に `git` が必要です。[Windows への導入](#windows-への導入installps1)を参照）:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://github.com/wireframeslayout/azito/releases/latest/download/install.ps1 | iex"
```

オプションを渡すときは、取得したスクリプトをスクリプトブロックとして呼びます（`iex` は引数を渡せません）:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((irm https://github.com/wireframeslayout/azito/releases/latest/download/install.ps1))) -Version v0.12.0 -Port 3010 -Yes
```

> **`| sh` ではなく `| bash`** — `install.sh` は `set -euo pipefail` を使っており、POSIX sh（dash）にはありません。Ubuntu / Debian で `| sh` を使うと即座に失敗します。

`--proto '=https'` はリダイレクト経路全体を HTTPS に制限します（`latest/download/` の URL は `release-assets.githubusercontent.com` に到達するまでに2回リダイレクトされます）。`--tlsv1.2` は TLS 1.0/1.1 へのダウングレードを拒否します。パイプ実行でも確認プロンプトは動作します（`install.sh` は標準入力ではなく `/dev/tty` から読むため）。

### 中身を読んでから実行

スクリプトをダウンロードし、確認してから実行します:

```bash
curl --proto '=https' --tlsv1.2 -fsSL -o install.sh https://github.com/wireframeslayout/azito/releases/latest/download/install.sh
less install.sh
bash install.sh
rm install.sh
```

### 厳密な検証（チェックサム）

インストーラのチェックサムを検証してから実行します。作業を一時ディレクトリで行います。

> 注: `install.sh` と `SHA256SUMS` は同一の GitHub リリースから同一の TLS 接続で取得するため、この検証が主に検出するのは転送中の破損であり、改竄に対する保護ではありません。tarball 本体の完全性検証は `install.sh` の内部でダウンロード後に `SHA256SUMS` と照合して行われ、この検証はインストーラの実行方法によらず常に実行されます。

```bash
AZITO_REPO=wireframeslayout/azito AZITO_VER=latest/download; \
TMP=$(mktemp -d) && \
curl --proto '=https' --tlsv1.2 -fsSL -o "$TMP/install.sh"  "https://github.com/$AZITO_REPO/releases/$AZITO_VER/install.sh" && \
curl --proto '=https' --tlsv1.2 -fsSL -o "$TMP/SHA256SUMS" "https://github.com/$AZITO_REPO/releases/$AZITO_VER/SHA256SUMS" && \
(cd "$TMP" && grep 'install\.sh$' SHA256SUMS | { command -v sha256sum >/dev/null && sha256sum -c - || shasum -a 256 -c -; }) && \
bash "$TMP/install.sh"; rm -rf "$TMP"
```

`install.sh` にオプションを渡す場合は末尾に足します（例: `bash "$TMP/install.sh" --no-service`）。
特定バージョンを入れる場合は `AZITO_VER=download/v0.3.0-rc2` のように書き換えてください。

### install.sh のオプション

| フラグ | 説明 | デフォルト |
|--------|------|-----------|
| `--version <tag>` | インストールするバージョン | latest |
| `--prefix <dir>` | インストール先 | `~/.azito` |
| `--no-service` | systemd/launchd 設定をスキップ | - |
| `--yes` | 確認プロンプトをスキップ | - |

### ホスト側に必要なもの

リリース版は Node.js を同梱していますが、それは**ハブ本体を動かすため**のものです（`node` バイナリ単体で、npm/npx は含みません）。以下はホスト側に必要です。

| ソフトウェア | 必須度 | 用途 |
|---|---|---|
| git | **必須** | タスクごとの worktree 作成。`install.sh` は有無を検出して導入を促す（バージョン検証はしない） |
| tmux | 任意 | tmux のウィンドウを使う場合だけ。AZITO のペインは**同梱の misao** が動かすので、無くてもインストール・利用できる（`install.sh` は無ければ注記を出すだけ）。推奨 3.4 以上 |
| Node.js v24+ | 機能により必要 | ブラウザランタイム導入（`npx` を使う）、supervised ウィンドウ（`azs` が `node` で supervisor を起動）。**ハブの起動自体には不要** |
| Tailscale | 任意 | 他端末からのアクセス、HTTPS 経由のプッシュ通知。macOS では、SSH セッションの `PATH` に無くても Homebrew の場所（`/opt/homebrew/bin`、`/usr/local/bin`）を探します |
| claude / codex CLI | 任意 | 対応するワーカーを使う場合のみ |

misao（ヘッドレスのペインサーバー）はリリースに同梱されています。ホストへのインストールは不要で、`install.sh` が[ハブとは別のサービス](#misao-サービス)として設置します。

Servers → 対象サーバー → Setup の Node.js 欄は、同梱 Node ではなくホスト側の Node.js を見ています。上の表の機能を使わないなら未導入のままで構いません。

ホストに Node.js を入れているのに未導入と表示される場合は、サービスの PATH に nodenv/nvm の shim が含まれていない可能性があります（v0.3.0-rc2 で修正済み）。それ以前のバージョンでは `~/.azito/hub/current/run.sh` を新しいものに差し替えてサービスを再起動してください。

## Windows 版の配布物

リリースには `azito-hub-<version>-win32-x64.zip`（Windows x64 のハブ）も含まれます。中身は `node.exe`、ハブ本体、`public/`、`harness/`、`deploy/` のテンプレート、Windows 上でビルドしたネイティブモジュール（better-sqlite3、ConPTY の node-pty）、ほかの配布物と同じ版の misao です。zip は `SHA256SUMS` に載ります。起動スクリプト `run.ps1`（`run.sh` に当たるもの）も含みます。

### Windows への導入（install.ps1）

`install.ps1`（リリースの資産。リポジトリのルートにもあります）は、Windows PowerShell 5.1 で現在のユーザー向けに導入します。管理者権限もシンボリックリンクも要りません。

**先に git を用意してください。** AZITO はタスクごとに git worktree を作るため、Git for Windows が PATH に必要です。インストーラは git を自動では入れません（導入先の外までマシンを変えてしまうため）。無いときは、何もダウンロードする前に止まり、入れ方を表示します:

```powershell
winget install --id Git.Git -e --source winget
```

（winget が無い場合は <https://git-scm.com/download/win>）。入れたあとは**新しい PowerShell を開いて**から実行してください。git を入れる前から開いていたウィンドウの PATH は変わりません。

```powershell
# ワンライナー（`curl | bash` に当たるもの）:
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://github.com/wireframeslayout/azito/releases/latest/download/install.ps1 | iex"

# オプション付き: スクリプトブロックなら `-File` と同じように引数を渡せます。
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((irm https://github.com/wireframeslayout/azito/releases/latest/download/install.ps1))) -Version v0.12.0 -Port 3010 -Yes

# ファイルから（リリースページから install.ps1 と SHA256SUMS を取得し、install.ps1 を SHA256SUMS で照合してから）:
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [-Version v0.12.0] [-Prefix <dir>] [-Port <n>] [-Yes] [-NoPath]
```

3 つの形はどれも同じに動きます。`irm` の前の `[Net.ServicePointManager]... -bor 3072;` は、スクリプト自身のダウンロードで TLS 1.2 を有効にします（Windows PowerShell 5.1 では既定で有効とは限らず、GitHub は TLS 1.2 を要求します）。インストーラは自分のダウンロードのために改めて有効にします。`iex` は引数を受け取らず、自前の引数を持つ関数やスクリプトの中から呼ぶと、その引数を受け取ってしまいます。そういう場所ではスクリプトブロックの形を使ってください。ワンライナーは、Windows 用のバンドルを含む最初のリリースである v0.12.0 から使えます。それ以前は 404 になります。インストーラはテキストとして実行されても困らないように書かれています。起動元の PowerShell を終了させず（失敗はそのコマンドを止めるエラーになり、`-Command` なら 0 以外で終わります）、そのセッションに変数・関数・`$ErrorActionPreference` の変更・一時ファイルを残しません。リリースに載る `install.ps1` は自分の tag を持っているので、ワンライナーは**その**リリースの zip と `SHA256SUMS` を取得し、「最新」を改めて問い合わせません（実行中に新しいリリースが出ても、2 つがずれることはありません）。リポジトリのチェックアウトにある写しは、GitHub API に最新のリリースを問い合わせます。

| オプション | 意味 |
|---|---|
| `-Version <tag>` | 導入する版（省略時は、この `install.ps1` が載ったリリース。チェックアウトの写しは最新のリリース） |
| `-Prefix <dir>` | 導入先（既定は `%USERPROFILE%\.azito`） |
| `-Port <n>` | ハブのポート（既定 `3001`）。新しい `hub\.env` の `PORT` に書かれ、`AZITO_ALLOWED_ORIGINS` には `localhost:<n>`・`127.0.0.1:<n>`・Tailscale の名前の `:<n>` が入ります。Tailscale の案内（`tailscale serve --bg <n>`）にも使われます。既にある `hub\.env` には触れません（`PORT` が違うときは警告します） |
| `-ZipPath <file>` | ダウンロードの代わりにローカルの `azito-hub-<tag>-win32-x64.zip` を使う（オフライン用）。`-Sha256Sums <file>` を足すと照合する。**足さないと zip は照合されません**（警告を表示）|
| `-Yes` | 確認を省く |
| `-NoPath` | `<prefix>\bin` をユーザーの PATH に足さない |
| `-NoService` | タスクスケジューラのタスクを登録しない。`azito run` で起動するか、あとから `azito service install` で登録する |

`irm | iex` では引数を渡せないので、各オプションは、コマンドの前に設定した環境変数でも指定できます: `AZITO_INSTALL_VERSION`・`AZITO_INSTALL_PREFIX`・`AZITO_INSTALL_PORT`・`AZITO_INSTALL_ZIPPATH`・`AZITO_INSTALL_SHA256SUMS`、および `AZITO_INSTALL_YES` / `AZITO_INSTALL_NOPATH` / `AZITO_INSTALL_NOSERVICE`（`1` を設定）。引数と環境変数の両方があれば引数が優先されます。`AZITO_INSTALL_ZIPPATH` で指定した zip は、照合なしでは使われません。`-Sha256Sums` または `AZITO_INSTALL_SHA256SUMS` でチェックサムのファイルを指定しないと、何も書く前に止まります（セッションに残った変数のせいで、通常の導入が未検証の zip に切り替わらないようにするためです）。PowerShell の窓で実行し、終わったら変数を消して、セッションに残さないでください。例: `$env:AZITO_INSTALL_PORT = 3010; [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://github.com/wireframeslayout/azito/releases/latest/download/install.ps1 | iex; Remove-Item Env:AZITO_INSTALL_PORT`。

zip と `SHA256SUMS` を取得し、チェックサムが合わなければ止まります。展開先のフォルダの外に出るエントリを含む zip も拒否します。配置:

```
<prefix>\hub\<version>\        展開した配布物（node.exe、azito-hub.cjs、run.ps1 など）
<prefix>\hub\current.txt       導入した版（1 行。Windows には `current` の symlink が無い）
<prefix>\hub\.env              設定（版のフォルダの外。更新で消えない）
<prefix>\data\                 データベース・鍵・トークン
<prefix>\bin\azito.cmd         CLI
<prefix>\logs\hub.log         ハブの標準出力・標準エラーのすべて（journal に当たるもの）。ハブの起動時に 10 MB を超えていれば hub.log.1 に退避する
```

`hub\.env` と `data\` は同梱のハブ自身（`node.exe azito-hub.cjs init-env`）が作ります。アクセス権（現在のユーザーだけ）は、実行時に守るのと同じコードが付けます。インストーラをもう一度実行すると、導入済みであることを表示して何も変えません。手で更新するときは、新しい zip を `hub\<tag>` に展開して `current.txt` にその tag を、BOM なし・末尾 CRLF の 1 行で書きます。Windows PowerShell 5.1 の `Set-Content -Encoding UTF8` や `>` は BOM 付き、または UTF-16 で書くため、`azito` は読み取りを拒否します。末尾の CRLF がないと、次のアプリ内更新が `current.txt must end with a CRLF` で失敗します。次のように書いてください:

```powershell
[System.IO.File]::WriteAllText("$env:USERPROFILE\.azito\hub\current.txt", "v0.12.0`r`n")
```

`current.txt` は、CLI と PATH の登録がすべて終わってから最後に書かれます。途中で止まった導入（`hub\<tag>` はあるが `current.txt` が無い）は、インストーラをもう一度実行すると完了します。`hub\.env` とそのトークンは保たれます。

CLI は `current.txt` を読んで同梱のハブを実行します:

| コマンド | 動作 |
|---|---|
| `azito start` / `azito stop` / `azito restart` / `azito status` | タスクスケジューラのタスク `AzitoHub`（下記）の起動・停止・再起動・状態表示。`status` は状態とログの場所を表示し、`stop` はこの導入の `node.exe` が残っていない状態になってから戻る |
| `azito run` | `run.ps1` 経由でハブを前面で実行（Ctrl+C で止める）。試しに動かすときや、`-NoService` で導入したとき用 |
| `azito token show` / `token rotate` | UI トークン（`hub\.env` に保存。そこに設定されている間は `rotate` が中止するので、そのファイルの `AZITO_UI_TOKEN` を書き換える） |
| `azito version` | `current.txt` の版と、配布物自身の版 |
| `azito service status\|start\|stop\|restart\|reload\|install` | Unix のサービスと同じ操作。`install` はタスクを登録する（install.ps1 が呼ぶ）。同じ定義の再登録は何もせず、違う定義はハブが動いている間は拒否される |
| `azito misao status\|install\|update\|start` | ハブ自身の misao をタスクスケジューラのタスク `AzitoMisao` として扱う（下と `misao.md`）。`install.ps1` が `install` を実行する。`update` は先にすべてのペインを終了する |

**未対応:** ハブのアンインストーラー。アプリ内の更新は [Windows のハブのアプリ内更新](#windows-のハブのアプリ内更新) です。

### Windows のハブから SSH / エージェントのサーバーを使う準備

Windows のハブは、Linux / macOS のハブと同じように SSH 経由でサーバーを追加し、Linux の agent を導入・更新できます（Windows ホストへの agent の導入は [Windows のエージェントサーバー](./windows-agent.md)）。ハブが探す場所は次のとおりです。

| 何を | どこを見るか |
|---|---|
| 秘密鍵 | `%USERPROFILE%\.ssh\id_ed25519`、無ければ `id_rsa`、`id_ecdsa`（`$HOME` ではなくユーザーのホームフォルダー） |
| ssh の設定 | `%USERPROFILE%\.ssh\config`（`HostName` / `Port` / `User` / `IdentityFile`。`IdentityFile ~/.ssh/key` の `~` はユーザーのホーム） |
| ホストの鍵 | `known_hosts` は読みません。初回接続で指紋を AZITO に記録し（初回は信頼）、変わると接続を拒否します（Linux / macOS のハブと同じ） |
| ssh-agent | 環境変数 `SSH_AUTH_SOCK` があればそれ（`\\.\pipe\…` か `pageant`）。無ければ OpenSSH の名前付きパイプ `\\.\pipe\openssh-ssh-agent` |
| ユーザー名 | `user@host` の形、無ければ ssh の設定の `User`、無ければ Windows のユーザー名（`USERNAME`） |

鍵ファイルだけで使うなら準備は要りません（ファイルにパスフレーズを付けた鍵は使えません。ssh-agent に入れてください）。ssh-agent を使うときは、Windows の **OpenSSH Authentication Agent** サービスを起動します（既定は無効です）。管理者の PowerShell で:

```powershell
Set-Service -Name ssh-agent -StartupType Automatic
Start-Service ssh-agent
ssh-add $env:USERPROFILE\.ssh\id_ed25519   # 鍵を入れる（パスフレーズを聞かれます）
ssh-add -l                                    # 入っている鍵の確認
```

サービスが止まっていてパイプが無いときは、ハブのログに「no ssh-agent」とその理由（起動のコマンド付き）を 1 回出し、鍵ファイルでの認証に進みます。ハブがタスクスケジューラのタスクとして動くときも同じパイプを使うので、`SSH_AUTH_SOCK` の設定は要りません。

共通の agent バンドルには、ハブの OS に関係なく Linux x86-64 用のネイティブモジュール（node-pty の `pty.node`）が必ず含まれます（macOS / Windows 用の prebuild も入っていて、1 つのバンドルがどの OS の agent にも使えます）。リリースの zip もほかのハブと同じバンドルを載せています。この変更で bundle hash が変わるため、導入済みの agent は通常の更新で一度だけ自動的に再デプロイされます。ソースからビルドした Windows のハブで agent を導入したいときは、Linux x64 でビルドした node-pty のフォルダー（`package.json` と `build/Release/pty.node`）を用意し、環境変数 `AZITO_AGENT_NODE_PTY_LINUX` にそのパスを設定してください。

### Windows の misao

`-NoService` を付けなければ、`install.ps1` はハブのタスクのあとに、同梱の misao（ペインサーバー）も入れます。同梱のハブで `azito misao install --prefix <prefix>` を実行し、`misao.exe` とライセンスを `<prefix>\misao\<version>\` に展開（同梱物の sha256 を照合）、タスクスケジューラのタスク `AzitoMisao`（ログオン時のタスク、`conhost.exe --headless`）を登録して起動し、`MISAO_SOCKET`（名前付きパイプ）を `hub\.env` に書きます。ハブの起動時に `run.ps1` がそれを読みます。エージェントサーバーに使うのと同じ導入処理を自分のマシンに向けたものなので、同じマシンのハブと Windows エージェントは 1 つのデーモンを共有します（1 ユーザーにつき 1 つの misao）。Unix と同じく misao は**ハブとは別**です。ハブの更新・`azito restart`・`azito stop` では止まりません（止めるとすべてのペインが閉じます）。切り替えは `azito misao update`（または Setup 行のボタン。確認あり）だけです。misao の導入に失敗しても警告で、`azito misao install` で繰り返せます。詳細は `misao.md`。

### タスクスケジューラのタスクとしてのハブ

`-NoService` を付けなければ、install.ps1 がタスク `AzitoHub` を登録し（同梱の `azito-hub.cjs service install` 経由。タスクの XML はハブ自身のコードが作り、PowerShell では書きません）、`/Run` で起動します。このタスクは:

- **あなたのログオン時**に起動します（ブート時ではありません）。あなたの権限（管理者権限なし）で動き、失敗すると 1 分おきに再起動します。ログオフ中はハブは動かず、再起動後はログオンが要ります
- `conhost.exe --headless powershell.exe <ランチャー>` を実行するので、デスクトップにコンソール窓は出ません。ランチャーは起動のたびに `hub\current.txt` を読み、その版の `run.ps1 -Service` を実行します。つまり**定義に版は含まれず**、手動の更新は `current.txt` を切り替えて `azito service restart` するだけで済み、タスクの再登録は要りません
- ハブの標準出力・標準エラーを `<prefix>\logs\hub.log` に書きます（`current.txt` が不正でランチャーが止まったときの理由もここ）。場所は `azito status` が表示します
- タスクと一緒に終わります。タスクスケジューラの「終了」（`azito stop`、`schtasks /End /TN AzitoHub`）が終わらせるのは `conhost.exe` だけなので、`run.ps1 -Service` がその ID をハブに伝え（`AZITO_HUB_EXIT_WITH_PID`）、いなくなって数秒でハブが自分で終了します（Windows の agent が親に付き従うのと同じ仕組み）。`azito stop|restart|reload` は、タスクを終わらせる前にハブの `node.exe`（`<prefix>\hub\` 配下のどの版のフォルダーでもよい。同じユーザー、コマンドライン引数の完全一致）を特定し、最大 20 秒ハブが自分で終了するのを待ち、そのあとも同じプロセス（ID と生成時刻）のままのものだけを強制終了します（強制したときは警告します）。そのため `current.txt` を切り替えてからの restart でも旧版の終了を待ち、新版が旧版とポートで衝突することはありません。ほかの prefix、ほかのユーザー、それ以外のプロセスには触れません
- **異常終了から自動で戻ります。** `conhost.exe --headless` は子に何があっても終了コード 0 を返し、タスクスケジューラは非 0 の終了コードでもタスクを再起動しない（Windows CI での実測）ので、戻すのは**ランチャー**です。ハブが非 0 の終了コード（クラッシュ、`Stop-Process -Force`、メモリ不足による強制終了など）で終わると、ランチャーは 5 秒後に起動し直し、以降は 10・20・40 秒、上限 60 秒の間隔で試します。5 分動き続けたら 5 秒からやり直します。起動のたびに `current.txt` を読み直し、不正なら理由をログに書いて 60 秒おきに再試行します。launcher は自分の `conhost.exe`（ID と開始時刻）を `run.ps1 -Service -FollowPid -FollowStart` に渡し、`run.ps1` はそのプロセスがまだ動いているときだけハブを起動します。そのため、起動の直前に入った End が、何にも追従しないハブを残すことはありません（この版の `run.ps1` が要ります。この版が登録したタスクは `current.txt` の版を実行するので、`current.txt` もこの版のバンドルに切り替えてください）。意図して終了したハブ（終了コード 0。停止を指示された、または親の `conhost.exe` がいなくなった）は**起動し直さず**、`azito stop|restart|reload` はタスクと一緒にランチャーも終わらせるので、戻りを止める操作は要りません。再起動は 1 回ごとに `hub.log`（`launcher: run.ps1 (v0.12.0) exited with code 1`、`launcher: start 2 in 5s`）と `<prefix>\logs\hub-launcher.json` に記録し、`azito status` が `launcher:` として表示します（タスク自身の Last Result は何があっても 0 のままです）。**限界:** あなたがログオンしている間だけ働きます（ログオン時のタスクのため）。起動のたびにすぐ失敗するハブは、60 秒おきにいつまでも再試行します（`hub.log` を読んでください）。以前の 0.12 のビルドが登録した、ハブを 1 回しか起動しないランチャーのタスクも `azito stop`/`start` は受け付け、`azito service install`（ハブを止めてから）で置き換わります（導入済みのハブへの `install.ps1` は何もしないので、この操作が要ります）

設定 › システムには、起動方式「Task Scheduler」が表示され、アプリ内の更新が使えます（[Windows のハブのアプリ内更新](#windows-のハブのアプリ内更新)）。手で更新するときは、新しい zip を `hub\<tag>` に展開し、tag を `current.txt` に（BOM なし・末尾 CRLF の 1 行で）書いて、`azito service restart` します。

install.ps1 は `current.txt` を書く前にタスクを登録し、書いたあとに起動します。途中で失敗しても、もう一度実行すれば直ります。起動だけが失敗したときは、ファイルは導入済みなので `azito start` を実行してください。導入済みのハブにはインストーラは何もしません（`install.sh` と同じ）。タスク名は固定なので 1 ユーザーに 1 つです。別の prefix 用に登録されたタスクは、`azito start|stop|restart|reload` が操作を拒否し、`azito service install` は `--yes` があるときだけ置き換えます（install.ps1 は `-Yes` のときに渡します）。動いているタスクは置き換えません。手で削除されたタスクは `azito service install` が登録し直します。手で消すには `schtasks /Delete /TN AzitoHub /F`（アンインストーラーはまだありません。写し `%USERPROFILE%\.azito\service\AzitoHub.xml` だけが残ると `azito status` が警告します）。

### Windows のハブのアプリ内更新

タスクスケジューラのタスク `AzitoHub` として動いているハブは、Linux / macOS のハブと同じように 設定 › システム から更新できます。ソースから動かしているハブや、`azito run` で手で起動したハブでは使えません（理由が画面に出ます。その場合は上のとおり手で更新します）。Windows の arm64 向けの配布物はまだ無いので、arm64 の Windows でも画面からは更新できません。

**使い方**

- 設定 › システム › 「更新を確認」で、最新の安定版が現在より新しければ「更新があります」と出ます。「更新して再起動」で始めます。
- 版を選んで入れるには、「開発中のバージョン」（RC チャンネル）を有効にします。「利用可能なバージョン」に一覧が出るので、版の行の「導入」を押します。現在より古い版は、ロールバックの確認が出ます。チャンネルの考え方は [更新チャンネル](#更新チャンネル) のとおりで、Unix と同じです。
- 実行中のタスクがあると、始まりません。完了してからやり直してください。
- 始まると進捗のダイアログが開きます。段階は「変更を取得」「SHA256 照合」「展開」「動作確認（展開後）」「切り替え」「再起動」「起動確認」です。再起動のあいだは「サーバーの応答を待機中…」と出て、新しい版が応答すると「更新が完了しました」になり、画面が読み込み直されます。失敗すると「更新に失敗しました」と理由が出ます。ダイアログのログは、今回の更新の行だけです。

**更新の流れ**

1. **1 回だけ動くタスク `AzitoHubUpdate`。** ハブは、更新を自分の子プロセスではなく、このタスクとして登録して `/Run` します。更新はハブ自身のタスク `AzitoHub` を終わらせて起動し直すので、ハブの子プロセスでは、ハブと一緒に終わってしまうためです。タスクが動かすのは、今の版の `node.exe` と `azito-hub.cjs` の `update-run` です（新しい版はまだ展開されていません）。トリガーは持たず、更新が終わるとタスク自身が消えます。
2. **取得と照合。** zip と `SHA256SUMS` をダウンロード（1 回 10 分で打ち切り）し、zip の SHA-256 を照合します。合わなければここで失敗し、何も変わりません。
3. **展開。** `hub\<版>` に展開します。フォルダーの外に出るエントリーやリンクを含む zip は拒否します。同じ名前のフォルダーが既にあるときは、書き込まず、zip の中身がすべてそこにある場合だけそれを使います。違えば、そのフォルダーを置き換えずに失敗します。
4. **新しい版での確認。** 新しい版の `node.exe` で `azito-hub.cjs --version` を実行し（30 秒まで）、版が合うかを確かめます。壊れた版は、ここで止まります。
5. **`current.txt` の切り替え。** BOM なし・末尾 CRLF の 1 行で、新しい版の名前に書き換えます。
6. **再起動。** `azito service restart` と同じ手順です。タスク `AzitoHub` を終わらせ、ハブの `node.exe` が自分で終了するのを待ち、起動し直します。ランチャーが `current.txt` を読み直すので、新しい版が動きます。
7. **起動の確認。** 新しい版が `/api/health` に自分の版で答えるまで、最大 90 秒待ちます（Windows の初回の起動は、ウイルス対策の検査のぶん遅いので、Unix の 30 秒より長くしています）。

更新の全体は 50 分で中止を求められ、実行中の段と、要るなら巻き戻しを終えてから終わります（その場で切られません）。タスクスケジューラ側の 1 時間の制限は、そのための保険です。

**失敗したら前の版に戻ります。** 切り替えの前に失敗したときは何も変わっていません。切り替えのあとに失敗したときは、`current.txt` を前の版に書き戻して再起動し、前の版が応答するのを確かめます。この回で作った新しい版のフォルダーは消えます（もとからあったものは消しません）。戻すのにも失敗したときは、画面のエラーにそう書かれます。起動の確認の最中に中止が届いても、新しい版が応答すれば更新は成功のままで、遅れて届いたことが状態の `note` に残ります。

**更新の最中は `azito service` が断られます。** `azito service install|start|stop|restart|reload` と更新は、同じインストールで同時には動きません。更新の最中に実行すると、`Another AZITO hub operation (process N) is running on this install ... Nothing was changed` と出て終わります（何も変わりません）。更新を始めるときに `azito service` が動いていれば、更新のほうが理由つきで失敗します。

**misao は止まりません。** misao は別のタスク `AzitoMisao` で、更新は触りません。misao の端末はハブが再起動する間だけ切れます。つなぎ直すと、同じ窓の続きが見えます。misao の更新は別の操作です（`azito misao update`、または Setup の行のボタン）。

**GitHub のトークン（`AZITO_GITHUB_TOKEN`）はコマンドラインに載りません。** 非公開のリポジトリから配布するときに、ハブの環境に設定するトークンです。タスクは環境変数を持てず、コマンドラインは同じマシンのすべてのプロセスから読めるので、トークンは本人しか読めないファイル `<prefix>\data\update-token` に書いて渡します。更新は、これを最初に読んで消します（更新が始まらなかったときにも、ハブが消します。残った分は次の更新が消します）。ハブの環境から渡す値のうち、引数に載るのはヘルスチェックの宛先（ハブの待ち受けアドレスとポート）だけです（版・ダウンロードの URL・フォルダーなど、環境によらない値も引数に載ります）。

**古い版の片付け。** 更新が成功したあと（戻したときは行いません）、`hub\` の古い版のフォルダーを消します。Unix のハブは今までどおり古い版を残し、片付けません。

- 残すもの: 今の版（`current.txt`）、更新の前の版（戻り先）、動いているプロセスが使っている版。実行ファイルかコマンドラインが、その版のフォルダーの下にあるプロセスが使っていると見なします。
- 対象は、更新が作る版の名前（`v0.12.0`、`v0.12.0-rc.1` の形）の、本物のフォルダーだけです。`.staging-*`、`.env`、`current.txt`、人が付けた `v0.12.0.bak.old` のような名前は見ません。版の名前のジャンクションやシンボリックリンクは、辿らず、そのまま残してログに書きます。
- 消す版は、`hub\` の中で `.prune-<版>-<ランダム>` に名前を変えてから、`rd /s /q` で消します。ツリーの中のジャンクションやマウントポイントは、リンクだけが消え、先は消えません。実行中の exe や読み込まれた DLL があって、書き込みで開けないファイルを含む版は、一部だけ消さずに丸ごと残します。消し残した `.prune-*` は、次の更新が消します。
- **前提: `hub\` フォルダーの ACL。** 本人・SYSTEM・Administrators 以外が `hub\` を変更できないことが前提です。そうでないと、確かめたあとにフォルダーをリンクに差し替えられるかもしれないので、片付け全体を見送ります。既定の場所（ユーザーのプロファイルの下）にある導入では、通常満たされます。
- **見送る場合。** 前提が満たされないとき、使用中かどうかを否定できないプロセスがあるとき、プロセスの一覧が取れないときは、何も消さずに見送ります。消せなかった版があるときも含め、更新そのものは成功のままです。理由は `update.log` と、状態の `note` に残り、次の更新がもう一度試します。`note` は、たとえば次のようになります。
  - `Old versions that could not be removed yet (the next update tries again): v0.11.2 (...)`
  - `Could not tidy the old versions: Cannot tell whether process ... uses an old version (its path is not readable), so no old version is removed. This is usually a window of the same user that runs as administrator ...`

更新で困ったときは、次の [Windows のハブの更新で困ったとき](#windows-のハブの更新で困ったとき) を見てください。

#### Windows のハブの更新で困ったとき

更新の記録は `<prefix>\data\` にあります。

| ファイル | 中身 |
|---|---|
| `update.log` | 段階ごとの記録。更新のたびに追記されるので、今回の分は末尾です。失敗した段階は `[<段階>] ERROR: ...`、片付けの見送りは `Left ... alone` / `Could not remove ...`、片付け全体の見送りは `Could not tidy the old versions: ...` |
| `update-state.json` | 最後の更新の状態（`status`、`step`、段階ごとの結果、`error`、`note`）。画面の進捗はこれを読みます |
| `update-run.out.log` | `update-run` の標準出力と標準エラー。状態を書く前に落ちたときの理由 |

| 症状 | 原因と手順 |
|---|---|
| 更新が始まらない | 理由が画面に出ます。(1) 実行中のタスクがある: 完了を待ちます。(2) 「既に実行中」: 前の更新が動いています（状態が `running` のまま 15 分たつと、古いものと見なして始められます）。(3) `A task named AzitoHubUpdate exists that AZITO did not register`: AZITO が作ったと確かめられない同名のタスクがあります。中身を確かめて、`schtasks /Delete /TN AzitoHubUpdate /F` で消してから、やり直します。(4) `An update of another install ... is running`: 別のインストールの更新が動いています。終わるのを待ちます |
| 更新が失敗した | 画面の理由と `update.log` の `ERROR` の行を読みます。切り替えの前なら何も変わっておらず、切り替えのあとなら前の版に戻っています（戻せなかったときはエラーに書かれます）。SHA256 が合わない、起動しない版、といった失敗でも、ハブは前の版で動き続けます |
| 古い版が片付かない | `update.log` の `Left ... alone` / `Could not ...`、または状態の `note` を読みます。**`Cannot tell whether process ... uses an old version`**: たいていは、管理者として動いている同じユーザーの窓（昇格した PowerShell など）です。非昇格のハブは、その実行ファイルのパスを読めないので、使用中でないと言い切れず、安全のために片付けを見送ります。その窓を閉じれば、次の更新で片付きます。ハブがその窓を閉じることはありません。**`the hub folder can be changed by others`**: `hub\` の ACL に、本人・SYSTEM・Administrators 以外の書き込み権があります。権限を直すと、次の更新で片付きます。**`a running process uses it` / `cannot be opened for writing`**: その版を使うプロセスを終わらせると、次の更新で片付きます |
| 前の更新のプロセスが残っている、ロックが取れない | `azito service ...` や更新が `Another AZITO hub operation (process N)` で断られ続けるときは、そのプロセス N を調べます。`update-run` を動かしている `node.exe` なら更新が続いています。50 分で自分に中止を求め、実行中の段と、要るなら巻き戻しを終えてから終わります。それでも終わらないときは、タスクマネージャーでそのプロセスを終了します（ロックはプロセスと一緒に OS が解放します）。タスク `AzitoHubUpdate` が残っていても、AZITO が作ったものなら、次の更新が前の `update-run` を終わらせてから登録し直します |
| 手で前の版に戻したい | 前の版のフォルダーが `hub\` に残っていることを確かめ（今の版と直前の版は、片付けで消えません）、`current.txt` をその版の名前に、BOM なし・末尾 CRLF の 1 行で書き換えて（`<prefix>\hub\current.txt`。既定の prefix は `%USERPROFILE%\.azito`）、`azito service restart` します: `` [System.IO.File]::WriteAllText("$env:USERPROFILE\.azito\hub\current.txt", "v0.12.0`r`n") ``。`>` や `Set-Content -Encoding UTF8` は BOM 付きまたは UTF-16 で書き、`WriteAllText` に CRLF を付けないと次のアプリ内更新が失敗するので、上の形で書いてください |
| プレリリースに更新できない | 既定（stable）では、安定版だけが対象です。プレリリース（`-rc.N`）は、「開発中のバージョン」を有効にしたときだけ一覧に出て、選んで入れられます。Unix と同じです |

## 手動インストール（tarball）

```bash
# 1. リリースページからダウンロード
VERSION=v0.4.0
PLATFORM=linux  # or darwin
ARCH=x64        # or arm64
curl --proto '=https' --tlsv1.2 -fsSLO "https://github.com/wireframeslayout/azito/releases/download/${VERSION}/azito-hub-${VERSION}-${PLATFORM}-${ARCH}.tar.gz"
curl --proto '=https' --tlsv1.2 -fsSLO "https://github.com/wireframeslayout/azito/releases/download/${VERSION}/SHA256SUMS"

# 2. SHA256 検証
sha256sum -c SHA256SUMS --ignore-missing

# 3. 展開
mkdir -p ~/.azito/hub/${VERSION}
tar xzf azito-hub-${VERSION}-${PLATFORM}-${ARCH}.tar.gz -C ~/.azito/hub/${VERSION}

# 4. シンボリックリンク
ln -sfn ~/.azito/hub/${VERSION} ~/.azito/hub/current

# 5. データディレクトリ作成
mkdir -p ~/.azito/data
chmod 700 ~/.azito/data

# 6. 環境変数設定（.env はバージョンディレクトリの外に置く。更新で消えないため）
cat > ~/.azito/hub/.env <<EOF
AZITO_DATA_DIR=$HOME/.azito/data
AZITO_UI_TOKEN=$(openssl rand -hex 32)
PORT=3001
# localhost 以外から開くなら、そのオリジンを必ず追加する（CORS と WebSocket の両方に効く）
# 例: Tailscale 経由なら https://<host>.ts.net を追加
AZITO_ALLOWED_ORIGINS=http://localhost:3001
EOF
chmod 600 ~/.azito/hub/.env

# 7. ダウンロードした一時ファイルを削除
rm -f azito-hub-${VERSION}-${PLATFORM}-${ARCH}.tar.gz SHA256SUMS

# 8. misao サービスを設置して起動（MISAO_SOCKET を ~/.azito/hub/.env に書く。ハブより先に行う）
~/.azito/hub/current/node ~/.azito/hub/current/azito-hub.cjs misao install

# 9. 起動
~/.azito/hub/current/run.sh
```

> 重要: `AZITO_DATA_DIR` を設定せずに起動すると `~/.azito/data` がデフォルトで使用されます。バンドルディレクトリ内にデータは作成されません。

## 設定ファイルの場所

**リリース版（tarball / install.sh）とソース版（git clone + `npm run dev`）で設定ファイルの場所が違います。** ここを取り違えると設定が効きません。

| | リリース版 | ソース版（開発） |
|---|---|---|
| 設定ファイル | `~/.azito/hub/.env` | `packages/server/.env` |
| データ | `~/.azito/data/` | `<repo>/data.db`, `<repo>/data/` |
| 反映方法 | `systemctl --user restart azito`（macOS は `azito service restart`） | `touch packages/server/src/main.ts`（`tsx watch` が再読込） |

`~/.azito/hub/.env` は**バージョンディレクトリの外**にあります（`~/.azito/hub/<version>/` ではない）。したがって更新で `current` が切り替わっても設定は失われません。データディレクトリ `~/.azito/data/` は DB・鍵・トークンの保管場所で、設定を書く場所ではありません。

`install.sh` が生成する `~/.azito/hub/.env` の内容:

```bash
AZITO_DATA_DIR=/home/you/.azito/data
AZITO_UI_TOKEN=<自動生成>
PORT=3001
AZITO_ALLOWED_ORIGINS=http://localhost:3001[,Tailscale を検出した場合はそのオリジンも]
#AZITO_BIND=127.0.0.1
```

### 新しいホスト名でアクセスするとき

AZITO は許可リストにあるオリジンからのアクセスしか受け付けません（CORS と WebSocket の両方）。未登録のホスト名で開くと、画面が真っ白になるか、ターミナルが `1008 Forbidden origin` で切断されます。

`~/.azito/hub/.env` の `AZITO_ALLOWED_ORIGINS` にカンマ区切りで追加し、サービスを再起動してください。

```bash
AZITO_ALLOWED_ORIGINS=http://localhost:3001,https://myhost.tail1234.ts.net
```

`install.sh` は実行時に `tailscale status` を見て MagicDNS 名を自動で追加します。インストール後に Tailscale を有効化した場合や、別のホスト名を使う場合は手動で追記してください。

### `AZITO_BIND` を変更すべきかどうか

既定の `127.0.0.1` のままでよい場合がほとんどです。判断基準は「AZITO のポートに直接つなぐか」だけです。

| 接続方法 | `AZITO_BIND` | 追加する `AZITO_ALLOWED_ORIGINS` |
|---|---|---|
| `tailscale serve` で HTTPS 終端 → localhost へ転送 | `127.0.0.1`（変更不要） | `https://<host>.ts.net` |
| Tailscale IP / MagicDNS 名の `:3001` に直接接続 | `<tailscale-ip>` | `http://<host>.ts.net:3001` |
| 同一マシンのブラウザのみ | `127.0.0.1`（変更不要） | 追加不要 |

`AZITO_BIND` は**1つのアドレスしか指定できません**（複数指定は不可）。`0.0.0.0` は明示的に拒否されます。リバースプロキシ（`tailscale serve` 等）が前段にある構成では、そちらが待ち受けを担うので AZITO 自身は `127.0.0.1` のままにしてください。

## サービス設定

### Linux (systemd)

`install.sh` が自動で設定します。手動で設定する場合:

```bash
mkdir -p ~/.config/systemd/user
cp ~/.azito/hub/current/deploy/azito-release.service ~/.config/systemd/user/azito.service
# __AZITO_PREFIX__ を実際のパスに置換
sed -i "s|__AZITO_PREFIX__|$HOME/.azito|g" ~/.config/systemd/user/azito.service

loginctl enable-linger $(whoami)
systemctl --user daemon-reload
systemctl --user enable --now azito
```

管理コマンド:

```bash
systemctl --user status azito
systemctl --user restart azito
journalctl --user -u azito -f
```

### macOS (launchd)

`install.sh` が自動で設定します。手動で設定する場合:

```bash
cp ~/.azito/hub/current/deploy/com.azito.hub.plist ~/Library/LaunchAgents/
# __AZITO_PREFIX__ を実際のパスに置換
sed -i '' "s|__AZITO_PREFIX__|$HOME/.azito|g" ~/Library/LaunchAgents/com.azito.hub.plist

azito service start    # user/<uid> に bootstrap する
```

### macOS: ログインの有無にかかわらず `user/<uid>` で動く

launchd にはユーザーごとのドメインが 2 つあります。`gui/<uid>`（そのユーザーが Mac の画面にログインしている間だけ）と、
`user/<uid>`（SSH を含め、そのユーザーのセッションがあれば）です。AZITO のハブ（`com.azito.hub`）と misao（`com.azito.misao`）は、
常に **`user/<uid>`** の Background セッション用 LaunchAgent として動きます（plist に `LimitLoadToSessionType = Background`。
`user/<uid>` はこれを必要とし、`gui/<uid>` は受け付けません）。

- **画面に誰もログインしていない Mac に SSH でインストール**しても、2 つのサービスは `user/<uid>` に bootstrap されてすぐ起動します
- **後から画面にログインしても、二重には起動しません。** Background 限定のおかげで macOS が plist を `gui/<uid>` に読み込まず、
  プロセスも PID もそのままです。**ログアウトしても止まりません。**
- **どちらのドメインで動いているか**は `azito service status`（ハブ）、`azito misao status`、`GET /api/system/misao`（`serviceDomain`）に出ます。この版以降は `user` です
- **この版より前のインストール**（v0.11.x 以前）は、限定なしの plist で `gui/<uid>` に読み込まれていました。サービスを起動・再起動・
  reload するとき（`azito service start|restart|reload`、画面からのハブ更新、`azito misao start|update`、`install.sh`）、AZITO は
  `gui/<uid>` にあるのを見つけて bootout し、plist に限定を足して `user/<uid>` に bootstrap し直します。失敗したときは元の plist を
  `gui/<uid>` に戻します。動いている misao は `azito misao install` では移しません（移すとペインが終了するため）。`azito misao update` を
  実行したときに移ります
- **bootout の後**は、launchd がジョブを忘れるまで待ってから bootstrap し、exit 5 のときは数回やり直します。`azito service reload` や更新でサービスが止まったまま残ることはありません
- **読み込みの失敗はエラー**: `install.sh` は `launchctl` のメッセージを表示して非ゼロで終わります。ファイルは入った状態なので、原因を直してから `azito service start` で再試行できます
- **両方のドメインに読み込まれている場合**（起きないはずです。移行の途中だけ両方に載りうる）: status が警告付きで `gui + user` を示し、
  `start` / `restart` / `reload` / `azito misao update` / ハブの更新はどちらかを推測せずに拒否します（API では `duplicate_load`）。
  `azito service stop`（両方から外す）→ `azito service start` を実行します。misao は `launchctl bootout gui/$UID/com.azito.misao` と
  `launchctl bootout user/$UID/com.azito.misao` で外し（ペインは終了します）、`azito misao start` で起動します

### 既存のインストールでの `azito service`

`azito service ...`（macOS では `azito start` / `stop` / `status` もこれを通ります）には、この版の `install.sh` が書く `~/.local/bin/azito` ラッパーが必要です。
古い `install.sh` が書いたラッパーはハブの更新では更新されないので、既存のインストールでは同梱の CLI を直接呼びます:

```bash
~/.azito/hub/current/node ~/.azito/hub/current/azito-hub.cjs service status    # start | stop | restart | reload も同じ
```

ラッパー自体を更新するには、インストール済みの版の `install.sh` から取り出します（この変更を含むリリースである必要があります。インストーラーはインストール済みのハブには何もせず、書くのはラッパーだけです）。新しいラッパーを確かめてから置き換えるので、取得に失敗しても既存のラッパーはそのままです:

```bash
(
  set -euo pipefail
  VERSION="$(head -1 ~/.azito/hub/current/version.txt)"   # `azito version` が出す値と同じ（例: v0.12.0）
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl --proto '=https' --tlsv1.2 -fsSL -o "$TMP/install.sh" "https://github.com/wireframeslayout/azito/releases/download/${VERSION}/install.sh"
  sed -n "/<<'WRAPPER'/,/^WRAPPER$/p" "$TMP/install.sh" | sed '1d;$d' > "$TMP/azito"
  test -s "$TMP/azito"        # 空でない
  bash -n "$TMP/azito"        # シェルとして正しい
  install -m 755 "$TMP/azito" ~/.local/bin/azito
)
```

### misao サービス

misao デーモンは**ハブとは別のサービス**（`azito-misao`）として動きます。misao を止めると全ペインが閉じてしまうため、
ハブの再起動や更新に巻き込まないよう分けています。

| | |
|---|---|
| 設置先 | `~/.azito/misao/<version>/`（このホストの OS / アーキテクチャに合う `misao` ネイティブバイナリとライセンス）。`~/.azito/misao/current` が使用中の版を指す |
| ソケット | `~/.azito/misao/misao.sock`（ディレクトリは mode 700、パスは 107 バイト以内）。`~/.azito/hub/.env` に `MISAO_SOCKET` として書かれる |
| 実行 | `misao serve`（単一のネイティブバイナリ。Node.js も node-pty も使わない） |
| サービス | Linux: systemd ユーザーユニット `azito-misao`（`KillMode=process`、`Restart=on-failure`、linger 有効）。macOS: launchd `com.azito.misao`（`KeepAlive` は `SuccessfulExit=false`、PATH と LANG を設定） |
| テンプレート | `deploy/azito-misao.service` / `deploy/com.azito.misao.plist`（リリースに同梱） |

```bash
azito misao status    # サービス・同梱版・稼働中の版・ソケットを表示
azito misao install   # 設置して起動（実行中のデーモンには触れない。繰り返しても安全）
azito misao update    # 同梱版へ切り替える。デーモンを止めるので実行中のペインはすべて終了（確認あり、--yes で省略）
azito misao start     # 設置済みで止まっているときに起動する

systemctl --user status azito-misao       # Linux
journalctl --user -u azito-misao -f
azito misao status                        # macOS（状態に launchd のドメインが出る）
launchctl print user/$UID/com.azito.misao  # macOS
```

- **新規インストール**: `install.sh` が設置・起動し、`.env` に `MISAO_SOCKET` を書きます（`--no-service` のときは設置せず、後で `azito misao install`）。
  新規 DB の local サーバーの既定のターミナル方式は **misao** です。
- **既存のインストール**: ハブを更新しても misao は設置されません。`azito misao install`、または Servers → 対象サーバー → Setup の
  misao 行の「misao をインストール」で設置します。`.env` を書き換えるので、その後にハブを再起動してください
  （`systemctl --user restart azito`。ペインは終了しません）。`.env` の `MISAO_SOCKET` が別のデーモンを指しているときは、
  既定では何も変えずに止まります。置き換えてよければ `azito misao install --replace-socket`（画面では確認ダイアログ）。
- **ハブの更新**: ハブを更新しても misao は**更新も再起動もされません**（`misao/current` はハブの更新で切り替わりません）。
  同梱版と稼働中の版が違う、またはプロトコルが合わないときは、Setup の misao 行にその旨と更新ボタンが出ます。
  更新は利用者が明示的に行います（ペインが不要なときに）。
- ソース版（`npm run dev`）はサービスを入れません。`MISAO_SOCKET`（未設定なら `~/.misao/misao.sock`）の misao に接続します。

## アップデート

アップデートは UI から行います（Settings → System → Check for updates）。CLI の `azito update` は未実装です。

`install.sh` は初回セットアップ専用です。既にインストール済みの場合は実行しても何もしません。

UI からの更新には制約があります。

| 条件 | 挙動 |
|---|---|
| systemd（Linux）で稼働 | 更新可能 |
| launchd（macOS）で稼働 | 更新可能 |
| タスクスケジューラ（Windows）で稼働 | 更新可能（[Windows のハブのアプリ内更新](#windows-のハブのアプリ内更新)） |
| サービス登録なしで起動 | 未対応。手動で切り替える |
| プレリリース（`v*-rc*`） | rc チャンネルに切り替えると更新対象に含まれる（後述） |

手動で切り替える場合は「手動インストール（tarball）」の手順1〜4を実行し、サービスを再起動してください。misao サービスは再起動されません（更新するときは `azito misao update`）。`~/.azito/hub/.env` とデータはバージョンディレクトリの外にあるため、そのまま引き継がれます。

### 更新チャンネル

AZITO は2つの更新チャンネルを持ちます。

| チャンネル | 説明 |
|---|---|
| `stable`（既定） | 安定版のみを追跡する。GitHub の "latest" リリースを参照 |
| `rc` | プレリリース（rc）を含むすべてのリリースを追跡する。SemVer 順で最新のリリースを提示 |

切り替えは Settings → System → 「開発中のバージョン」トグルで行います。`rc` に切り替えると利用可能なバージョン一覧が表示され、特定のバージョンを選んで導入できます。

`rc` チャンネルでは、安定版より古い rc が「更新あり」として提示されることはありません（バージョン比較で現在より新しいもののみ提示されます）。

### プレリリースの命名規則

```
安定版:       v0.4.0
プレリリース: v0.4.0-rc.1, v0.4.0-rc.2, …
```

SemVer 2.0 のプレリリース識別子に揃え、`-rc.N`（ドット区切り）形式を使用します。

### rc の作成・昇格ルール

| 項目 | 規則 |
|---|---|
| 起点 | 次期安定版の内容が揃った時点で `-rc.1` を発行する |
| rc 中の変更 | 修正のみ。機能追加を入れる場合は安定版のバージョンを上げ直す |
| 番号 | 修正を入れるたびに `-rc.N` を単調増加させる |
| 安定版への昇格 | 最後の rc と同一コミットに安定版タグを打つ |
| GitHub 上の扱い | ハイフンを含むタグは pre-release として公開する |

## Agent サーバーの自動更新

Hub 起動時に、登録済みの Agent サーバーすべてのバージョンを自動で確認します。更新はコンテンツハッシュ（バンドルファイルの SHA256）で判定されます。

| 状態 | 挙動 |
|---|---|
| ハッシュ不一致 | 自動で再配備（ビルド → SSH 転送 → 再起動） |
| 実行中タスクあり | 延期（deferred）。次回の Hub 起動時に再チェック |
| ハッシュ一致 | 何もしない（`up_to_date`） |

手動で更新する場合は Servers → 対象サーバー → Setup → Agent Server の「Reinstall」を使用します。

## Windows ホストをエージェントとして追加する

Servers → Add → Agent で、SSH 経由で Windows ホストをエージェントサーバーとして追加できます（導入、ファイアウォールの規則、misao、更新、削除、使える機能の表、制約、トラブルシューティング）。手順と仕様は [Windows のエージェントサーバー](./windows-agent.md) にまとめてあります。Windows 側の準備は同じ文書の[準備](./windows-agent.md#準備)です。

Windows の agent も、ハブの起動時に版が違えば自動で更新されます（[Agent サーバーの自動更新](#agent-サーバーの自動更新)と同じ判定。手順は[更新](./windows-agent.md#更新)）。

## ロールバック

```bash
# 利用可能なバージョンを確認
ls ~/.azito/hub/

# 旧バージョンに切り替え
ln -sfn ~/.azito/hub/v0.3.0 ~/.azito/hub/current

# サービス再起動
systemctl --user restart azito  # Linux
# or
launchctl kickstart -k "gui/$(id -u)/com.azito.hub" || launchctl kickstart -k "user/$(id -u)/com.azito.hub"    # macOS
```

Windows のハブは `current.txt` を書き換えて `azito service restart` します（[手で前の版に戻したい](#windows-のハブの更新で困ったとき)）。

## CLI コマンド

`install.sh` は `~/.local/bin/azito` に CLI ラッパーを配置します。

```bash
azito start          # 起動（Linux: フォアグラウンド。macOS: 属するドメインで launchd のサービスを起動）
azito stop           # サービス停止
azito status         # サービス状態確認
azito token show     # UI トークン表示
azito token rotate   # UI トークン再生成
azito misao status   # misao サービスの状態（install / update / start も同じ形）
azito service status # ハブ自身のサービス（start / stop / restart / reload も同じ形。macOS は launchd のドメインも表示）
azito version        # バージョン表示
```

> **注意:** `azito` CLI はリリース版（`install.sh` で導入した環境）専用です。ソース版（`git clone` + `npm run dev`）には CLI ラッパーがないため、トークンは `packages/server/.env` または `data/ui-token` を直接参照してください。

## サポートプラットフォーム

| OS | アーキテクチャ | 状態 |
|----|---------------|------|
| Linux | x86_64 (x64) | サポート |
| Linux | aarch64 (arm64) | サポート |
| macOS | Apple Silicon (arm64) | サポート |
| macOS | Intel (x64) | 未対応（要望があれば検討） |

## 配布先リポジトリの移行

OSS 移行後、配布先リポジトリが `wireframeslayout/azito` に変更される場合があります。

ビルド時にリポジトリを指定するには:

```bash
npm run build:hub -- --repo wireframeslayout/azito
# or
AZITO_RELEASE_REPO=wireframeslayout/azito npm run build:hub
```

## macOS の手動更新（フォールバック）

macOS（launchd）環境でも Settings → System から画面上で更新できます（読み込まれているドメインで `launchctl kickstart` して自動再起動）。画面更新が使えない場合のフォールバック手順として以下を残します。

```bash
# 1. 最新バージョンを確認
REPO="wireframeslayout/azito"  # 配布元リポジトリ
LATEST=$(curl --proto '=https' --tlsv1.2 -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep tag_name | cut -d '"' -f 4)
echo "Latest: $LATEST"

# 2. tarball と SHA256SUMS をダウンロード
# 配布しているのは Apple Silicon (arm64) のみ。Intel Mac は未対応
if [ "$(uname -m)" != "arm64" ]; then
  echo "Intel Mac (x86_64) 向けのビルドは配布していません" >&2; exit 1
fi
TARBALL="azito-hub-${LATEST}-darwin-arm64.tar.gz"
curl --proto '=https' --tlsv1.2 -fsSLO "https://github.com/$REPO/releases/download/$LATEST/$TARBALL"
curl --proto '=https' --tlsv1.2 -fsSLO "https://github.com/$REPO/releases/download/$LATEST/SHA256SUMS"

# 3. sha256 照合
shasum -a 256 -c SHA256SUMS --ignore-missing

# 4. 展開
mkdir -p ~/.azito/hub/"$LATEST"
tar xzf "$TARBALL" -C ~/.azito/hub/"$LATEST" --no-same-owner --no-same-permissions

# 5. スモークテスト
~/.azito/hub/"$LATEST"/node ~/.azito/hub/"$LATEST"/azito-hub.cjs --version

# 6. current を切り替え
ln -sfn ~/.azito/hub/"$LATEST" ~/.azito/hub/current

# 7. サービスを再起動
launchctl kickstart -k "gui/$(id -u)/com.azito.hub" || launchctl kickstart -k "user/$(id -u)/com.azito.hub"

# 8. 健全性確認
sleep 3 && curl -s http://localhost:3001/api/health | grep version

# 9. クリーンアップ
rm -f "$TARBALL" SHA256SUMS
```

失敗した場合は旧バージョンに戻します:

```bash
# 旧バージョンの symlink を復元
ls ~/.azito/hub/  # 既存バージョンを確認
ln -sfn ~/.azito/hub/<旧バージョン> ~/.azito/hub/current
launchctl kickstart -k "gui/$(id -u)/com.azito.hub" || launchctl kickstart -k "user/$(id -u)/com.azito.hub"
```

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| Tailscale の URL に接続できない（connection refused） | AZITO が `127.0.0.1` だけで待ち受けている | `~/.azito/hub/.env` に `AZITO_BIND=<tailscale-ip>`（`tailscale ip -4` の出力）を設定して再起動。または `tailscale serve --bg 3001` で HTTPS 終端し `AZITO_BIND` は既定のままにする |
| 接続はできるが画面が真っ白／ターミナルが切れる | `AZITO_ALLOWED_ORIGINS` にそのオリジンが無い | 開いている URL のオリジンを `AZITO_ALLOWED_ORIGINS` に追加して再起動 |


### 「misao に接続できない」

```bash
azito misao status                    # サービスが動いているか、同梱版との差
systemctl --user status azito-misao   # Linux（macOS は `azito misao status` でドメインを確認し、`launchctl print <gui|user>/$UID/com.azito.misao`）
```

停止していれば `azito misao start`、未設置なら `azito misao install` です。`azito misao status` に「restart the hub」と出ているときは、
ハブの `.env` の `MISAO_SOCKET` と、ハブが実際に使っているソケットが違います。ハブを再起動してください。

### 「Node.js が見つからない」

リリースバンドルには Node.js が同梱されています。`run.sh` は同梱の `./node` を使用するため、ホストに Node.js をインストールする必要はありません。

### 「AZITO_UI_TOKEN が設定されていない」

```bash
azito token show
# or
grep AZITO_UI_TOKEN ~/.azito/hub/.env
```

### 「ポート 3001 が使用中」

```bash
ss -ltn | grep :3001
# 開発用サーバーが動いている場合は停止
```

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

Servers → Add → Agent で、SSH 経由で Windows ホストを追加できます。agent は動きますが、**Windows には misao も tmux もまだ入りません**（#369 A3）。そのためペインサーバーが無く、導入結果には misao の `unsupported_os` の理由が、導入成功と並べて出ます。Windows でのファイル・git・タスク実行は #370 / #371、Windows の agent の更新と削除は #372 です（Windows の agent は Setup の行から再導入すると、その場で置き換わります）。

Windows 側の準備:

| 前提 | 内容 |
|---|---|
| OpenSSH サーバー | Windows 側で有効化し、ハブから到達できること。既定シェルは **cmd.exe のままでよい**（PowerShell でも可）。ハブは先に OS を判定し、以後の確認は両方で同じに動く PowerShell スクリプトで行います。SSH で入るユーザーが、agent を動かすユーザーになります |
| Windows | x64 のみ。OS ネイティブのアーキテクチャで判定（ARM 版 Windows は x64 エミュレーション下でも理由付きで拒否）。Windows 10 1809（ビルド 17763）以降、Windows Server 2019 以降（`tar.exe` と `conhost.exe --headless` のため。preflight が確認します）。Windows の版（10 / 11 / Server）は表示だけで検査しない |
| Node.js v24+ | SSH セッションの PATH にあること |
| Tailscale | 導入済みでサインイン済みであること。PATH に無くても `%ProgramFiles%\Tailscale\tailscale.exe` を探します |
| Windows ファイアウォール | `node.exe` への受信 TCP 3002 を許可し、Block 規則が無いこと（下の手順 1） |

OS の判定は、sh・cmd.exe・PowerShell で出力が変わる 1 本の `echo AZITO_OS:%OS%:$?`（変数を読まないので `set -u` でも動く）で行い、どれにも当てはまらない応答は推測せずエラーにします。

導入で行うこと（管理者権限は要りませんし、求めません）:

1. **Windows ファイアウォールの確認。** Windows は、規則が許可するまでプログラムへの受信を遮ります。初回の許可ダイアログはデスクトップに出るだけで、SSH のセッションには出ません。導入は、有効な受信の規則をすべて（ポート・プログラム・アドレスのフィルターごと）読み、TCP 3002・`node.exe`・agent が bind する Tailscale の IP について次のように判定します:
   - **許可（Allow）** 規則は、次のすべてを満たすときだけ数えます: プロトコルが TCP か Any、ローカルポートが 3002 か Any（`3000-3010` のような**範囲指定は読まない**ので数えません）、プログラムが `node.exe` か Any、リモートアドレスが Any かタンネル範囲 `100.64.0.0/10`（LocalSubnet など**他のリモートアドレスに絞った規則**はハブに届かないので数えません）、ローカルアドレスが Any か agent の IP。プロファイルは見ません。
   - ポート 3002 または `node.exe` に当たる、有効な受信の **Block** 規則があれば、その DisplayName を示して止まります（初回のダイアログをキャンセルすると Windows が作ります）。Block は Allow より優先されるので、その横に追加はしません。
   - 条件を満たす Allow も Block も無く、SSH のセッションが管理者（昇格したトークン）なら、このプログラム・このローカルアドレス・`100.64.0.0/10` からだけ、の `AZITO Agent (TCP 3002)` を追加します。昇格していなければ、**何も転送する前に止まり**、管理者の PowerShell で 1 回だけ実行するコマンドを表示します:
   `New-NetFirewallRule -DisplayName "AZITO Agent (TCP 3002)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3002 -Program "C:\Program Files\nodejs\node.exe" -LocalAddress <Tailscale の IP> -RemoteAddress 100.64.0.0/10 -Profile Any`（実際のパスと IP が入って表示されます）。
   - ホストが答えられない場合（NetSecurity モジュールが無いなど）は止めません。ヘルスチェックが失敗したとき、ファイアウォールを名指しします。
2. **転送。** バンドルを SFTP で `%USERPROFILE%\.azito\agent\` へ送り、ホスト上で SHA256 を照合します。
3. **展開。** 標準の `tar.exe` で `%USERPROFILE%\.azito\agent\<version>\` に展開します（先に、フォルダーの外へ出るパスが無いか検査します）。フォルダーは本人だけが読めます。symlink は使いません。下のタスクが版のフォルダーを直接指すので、再導入のたびにタスクを登録し直します。
4. **設定。** トークン、bind するアドレス（Tailscale の IP）、ポートは `%USERPROFILE%\.azito\agent\agent.env` に書きます。本人だけが読める ACL にし、そうなっていなければハブが検査して先へ進みません。agent は `conhost.exe --headless node.exe --env-file=<そのファイル> <版のフォルダー>\azito-agent.cjs` で起動するので、起動用のスクリプトは挟まず、デスクトップにコンソールウィンドウも出ません。設定ファイルは、トークンを書く前に本人専用で作成してから置き換えます。既存の `agent.env` には書き込みません。agent 自身のログは `%USERPROFILE%\.azito\agent\agent.log` に書かれます。
5. **常駐。** タスクスケジューラのタスク `AzitoAgent` を登録します。**SSH で入ったユーザーのログオン時に起動**し（ユーザー権限、失敗時は再起動）、続けて `/Run` します。
6. **ヘルスチェック。** Linux と同じです。再導入は、新しい agent が応答するまでをひとつの操作として扱います。それまでの旧タスク定義・設定・同じ版のフォルダー・稼働状態は退避しておき、新しい agent が起動しない・応答しないときは**元に戻し**（旧 agent を再起動し）ます。ハブが持つトークンとホストの `agent.env` が食い違ったまま残ることはありません。退避したものは、新しい agent の健全を確認してから削除します。

**agent は、そのユーザーが Windows にログオンしている間だけ動きます**（コンソールでも、リモートデスクトップでも）。再起動後はログオンするまで何も起動せず、ログオフすると agent は止まります。ログオフしても動き続けるサーバーには、自動ログオンなど別の方式が要りますが、まだ用意していません。

運用:

| 操作 | 方法 |
|---|---|
| 再起動 | ハブが agent に届かないとき、タスクを再起動します（`schtasks /End` のあと `/Run`）。または Setup の行の「Reinstall」 |
| 停止 | ホスト上か SSH で `schtasks /End /TN AzitoAgent`（次のログオンでまた起動します。起動させたくなければ `schtasks /Change /TN AzitoAgent /DISABLE` も） |
| 削除（#372 まで） | `schtasks /End /TN AzitoAgent`、`schtasks /Delete /TN AzitoAgent /F`、`%USERPROFILE%\.azito\agent` を削除。導入が規則を追加していた場合は `Remove-NetFirewallRule -DisplayName "AZITO Agent (TCP 3002)"` |

本物の agent の隣で 2 つ目を試すときは、ハブの環境変数 `AZITO_WIN_AGENT_TASK_NAME`、`AZITO_WIN_AGENT_DIR`（ユーザーのホーム直下のフォルダー）、`AZITO_WIN_AGENT_PORT` を設定します。既定は `AzitoAgent`、`.azito\agent`、`3002` です。これは試験用です。サーバーごとには保存されないので、これらを付けずに起動したハブは既定のタスクを探します（使われているときはハブのログに 1 行出ます）。その一時ハブだけで使ってください。

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

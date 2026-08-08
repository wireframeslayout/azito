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
| tmux | **必須** | AZITO はホストの tmux セッションを操作する。`install.sh` は tmux の有無を検出して導入を促す（バージョン検証はしない）。推奨 3.4 以上 |
| git | **必須** | タスクごとの worktree 作成。同上 |
| Node.js v24+ | 機能により必要 | ブラウザランタイム導入（`npx` を使う）、supervised ウィンドウ（`azs` が `node` で supervisor を起動）。**ハブの起動自体には不要** |
| Tailscale | 任意 | 他端末からのアクセス、HTTPS 経由のプッシュ通知 |
| claude / codex CLI | 任意 | 対応するワーカーを使う場合のみ |

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

# 8. 起動
~/.azito/hub/current/run.sh
```

> 重要: `AZITO_DATA_DIR` を設定せずに起動すると `~/.azito/data` がデフォルトで使用されます。バンドルディレクトリ内にデータは作成されません。

## 設定ファイルの場所

**リリース版（tarball / install.sh）とソース版（git clone + `npm run dev`）で設定ファイルの場所が違います。** ここを取り違えると設定が効きません。

| | リリース版 | ソース版（開発） |
|---|---|---|
| 設定ファイル | `~/.azito/hub/.env` | `packages/server/.env` |
| データ | `~/.azito/data/` | `<repo>/data.db`, `<repo>/data/` |
| 反映方法 | `systemctl --user restart azito`（macOS は `launchctl kickstart -k gui/$UID/com.azito.hub`） | `touch packages/server/src/main.ts`（`tsx watch` が再読込） |

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

launchctl load ~/Library/LaunchAgents/com.azito.hub.plist
```

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

手動で切り替える場合は「手動インストール（tarball）」の手順1〜4を実行し、サービスを再起動してください。`~/.azito/hub/.env` とデータはバージョンディレクトリの外にあるため、そのまま引き継がれます。

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

## ロールバック

```bash
# 利用可能なバージョンを確認
ls ~/.azito/hub/

# 旧バージョンに切り替え
ln -sfn ~/.azito/hub/v0.3.0 ~/.azito/hub/current

# サービス再起動
systemctl --user restart azito  # Linux
# or
launchctl unload ~/Library/LaunchAgents/com.azito.hub.plist && \
launchctl load ~/Library/LaunchAgents/com.azito.hub.plist    # macOS
```

## CLI コマンド

`install.sh` は `~/.local/bin/azito` に CLI ラッパーを配置します。

```bash
azito start          # 起動（フォアグラウンド）
azito stop           # サービス停止
azito status         # サービス状態確認
azito token show     # UI トークン表示
azito token rotate   # UI トークン再生成
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

macOS（launchd）環境でも Settings → System から画面上で更新できます（`launchctl kickstart` で自動再起動）。画面更新が使えない場合のフォールバック手順として以下を残します。

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
launchctl kickstart -k "gui/$(id -u)/com.azito.hub"

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
launchctl kickstart -k "gui/$(id -u)/com.azito.hub"
```

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| Tailscale の URL に接続できない（connection refused） | AZITO が `127.0.0.1` だけで待ち受けている | `~/.azito/hub/.env` に `AZITO_BIND=<tailscale-ip>`（`tailscale ip -4` の出力）を設定して再起動。または `tailscale serve --bg 3001` で HTTPS 終端し `AZITO_BIND` は既定のままにする |
| 接続はできるが画面が真っ白／ターミナルが切れる | `AZITO_ALLOWED_ORIGINS` にそのオリジンが無い | 開いている URL のオリジンを `AZITO_ALLOWED_ORIGINS` に追加して再起動 |


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

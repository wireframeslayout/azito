# セキュリティ設定・環境構築ガイド

## この文書の位置づけ

セキュリティ強化（Phase 0〜3）により、AZITO はセキュリティ関連の設定を自動的に行うようになりました。UI トークン（`AZITO_UI_TOKEN`）は未設定の場合に自動生成されます。MinIO を使う場合のみ、資格情報の手動設定が必要です。本ガイドは次の2つをカバーします。

- **[既存環境の移行手順](#既存環境の移行手順)** -- すでに AZITO を動かしている環境をこの変更に追従させる
- **[新規開発環境の構築手順](#新規開発環境の構築手順)** -- クリーンな状態から開発環境を立ち上げる

リリースバンドルからのインストールについては [インストールとアップデート](install-and-update.md) を参照してください。

## 変更サマリ

| 変更点 | 影響 | 必要な対応 |
|---|---|---|
| API / WebSocket に認証が必須 | 未認証リクエストは 401、WS は `close(1008)` | `AZITO_UI_TOKEN` は自動生成される。`azito token show`（リリース版のみ）で確認し、ブラウザ初回アクセス時に入力。固定したい場合は env に設定 |
| bind アドレスが `127.0.0.1` 既定 | LAN / Tailscale からアクセスできない | 必要なら `AZITO_BIND` を設定 |
| CORS が許可オリジン限定 | 未登録オリジンからのブラウザアクセスが失敗 | 必要なら `AZITO_ALLOWED_ORIGINS` を設定 |
| MinIO の資格情報が必須 | `docker compose up` が失敗 | ルートの `.env` に資格情報を設定 |
| harness のトークン配送方式変更 | `/azt-*` スキルの API 呼び出しが 401 | 各サーバーで `setup.sh` を再実行 |
| DB の秘密カラムを暗号化 | `data/master.key` が自動生成される | 鍵ファイルをバックアップ |
| SSH ホスト鍵の TOFU 検証 | ホスト鍵変更時に SSH 接続が拒否される | 意図した変更なら fingerprint をリセット |
| agent の token 配送方式変更 | 既存 agent は旧形式のまま動作 | 再インストールで移行（任意） |
| ブランチ名・パスの境界検証 | 記号を含む値が 400 で拒否される | 該当タスクの値を修正 |
| harness 配布方式の分離（Issue #28 Phase B） | `~/.azito/azitoctl*.env` に `AZITO_UI_TOKEN` が含まれなくなり、代わりに `~/.azito/operator.env` に置かれる | `setup.sh` を再実行。`azito auth doctor` で残留を確認 |

## 環境変数リファレンス

環境変数ファイルは**2つ**あり、役割が異なります。混同しやすいので注意してください。

| ファイル | 読み込む主体 | 用途 |
|---|---|---|
| `packages/server/.env` | AZITO サーバー（`tsx watch --env-file-if-exists=.env` / systemd の `EnvironmentFile`） | サーバーの動作設定 |
| `<リポジトリルート>/.env` | `docker compose`（既定の env ファイル） | MinIO の資格情報 |

いずれも git 管理外です。雛形は `.env.example` にあります。

### `packages/server/.env`

| 変数 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `AZITO_UI_TOKEN` | 任意 | `$AZITO_DATA_DIR/ui-token` を自動生成 | API / WebSocket 認証用トークン（operator の全権クレデンシャル）。env → ファイル → 自動生成の順で解決。`azito token show`（リリース版）で確認、`azito token rotate` でローテーション可能。ソース版では `packages/server/.env` または `data/ui-token` を直接参照。`azito token rotate` はローカルの `~/.azito/operator.env` と `~/.claude/settings.json` の MCP トークン（存在する場合のみ）を自動更新する。**`~/.azito/azitoctl*.env` は更新しない**（Issue #28 Phase B: このファイルには置かない） |
| `AZITO_DATA_DIR` | 任意 | リポジトリルート直下（`data.db`, `data/*`） | 永続データディレクトリ。設定すると `data.db`, `master.key`, `vapid-keys.json`, `ui-token`, `browser-profile/`, `sidekicks/` がこのディレクトリ配下に統合される（mode 700）。バージョンディレクトリ方式での運用時に必須 |
| `AZITO_BIND` | 任意 | `127.0.0.1` | 待ち受けアドレス。`0.0.0.0` と `::` は明示的に拒否される。リモートアクセス時は Tailscale IP を指定 |
| `AZITO_ALLOWED_ORIGINS` | 任意 | `http://localhost:5173,http://localhost:3001` | CORS と WebSocket の Origin 検証で許可するオリジン（カンマ区切り） |
| `AZITO_WEBHOOK_TOKEN` | 任意 | 起動ごとにランダム生成 | hook / agent-signal / supervisor 用の共有トークン。固定したい場合に設定 |
| `AZITO_MASTER_KEY` | 任意 | `$AZITO_DATA_DIR/master.key` を自動生成 | DB の秘密カラム暗号化キー（hex 64文字）。環境変数を優先 |
| `AZITO_SIDEKICKS_DIR` | 任意 | `$AZITO_DATA_DIR/sidekicks` | ユーザー層 Sidekick パッケージの格納先。`AZITO_DATA_DIR` 設定時はその配下の `sidekicks/` がデフォルト |
| `AZITO_VAPID_SUBJECT` | 任意 | `mailto:admin@example.com` | プッシュ通知の VAPID subject |
| `AZITO_PUBLIC_URL` | 任意 | なし | supervisor・リモート Agent がハブへ到達するための URL。`tailscale serve` 利用時は `https://<MagicDNS>` を設定 |
| `AZITO_MUX_RUNTIME` | 任意 | `system` | サーバーの tmux 実行系統（`system` / `managed`） |
| `AZITO_UNIT_TYPES_DIR` | 任意 | `data/unit-types` | ユーザー層 UnitType TOML 定義の読み込みディレクトリ（ビルトイン層 `harness/unit-types/` は常に読まれる） |
| `AZITO_HARNESS_PREFIX` | 任意 | なし | UI 経由の harness リモート配置で `~/.azito/harness-<prefix>` のように識別子として付加される |
| `AZITO_RELEASE_REPO` | 任意 | `wireframeslayout/azito` | 更新チェック・ダウンロードに使う GitHub リポジトリ |
| `AZITO_GITHUB_TOKEN` | 任意 | なし | GitHub API レート制限を回避するための PAT（更新チェック時に使用） |
| `PORT` | 任意 | `3001` | サーバーのポート |

### ルートの `.env`

| 変数 | 必須 | 説明 |
|---|---|---|
| `MINIO_ROOT_USER` | MinIO を使う場合は**必須** | 未設定だと `docker compose up` が失敗する |
| `MINIO_ROOT_PASSWORD` | MinIO を使う場合は**必須** | 同上。十分に長い値を設定する |

---

## 主体分離(operator / task)

Issue #28 では、API を呼び出しているのが**誰か**を区別する `principal`（主体）モデルを導入しました。
**operator**（人間、または全権で操作するブラウザセッション・CLI）と **task**（worktree 内で
自律的に動くエージェント。自分自身のリソースにスコープされる）の2種類です。本節では、それぞれが
持つ資格情報と、operator の全権トークンを task 側プロセスが読むファイルへ置かないための
harness 配布分離（Phase B）を説明します。

### 主体ごとの資格情報

| 主体 | 資格情報 | 置き場所 |
|---|---|---|
| operator | `AZITO_UI_TOKEN` | ブラウザのセッションストレージ、または `~/.azito/operator.env`（人間が明示的に source した場合のみ有効） |
| task | `AZITO_TASK_TOKEN` | ハブがそのタスクのワーカーウィンドウ作成（再作成）時にのみ、そのウィンドウの tmux ペイン env へ注入する |

`azt-*` スキルはまず `AZITO_TASK_TOKEN` を探し、無ければ `AZITO_UI_TOKEN` にフォールバックする
ため、タスクのペイン内から呼ばれても、人間が手動で開いたターミナルから呼ばれても同じスキルが動作
します。

### `~/.azito/operator.env`

`setup.sh` に `--ui-token` を渡すと、`AZITO_URL` と `AZITO_UI_TOKEN` を `~/.azito/operator.env`
（mode 600）に書き出します。**このファイルは `setup.sh` 自身を含め、いかなるスクリプトからも
自動的に読み込まれません。** 使うには:

```bash
source ~/.azito/operator.env
azito units list       # operator 権限が必要な他のコマンド
```

**このファイルを `source` した直後に `azito token rotate` を実行してはいけません。**
`rotate` は環境に `AZITO_UI_TOKEN` が既に設定されていると必ず中止します。`operator.env` を
`source` するとまさにその状態になるため、「同じシェルで source してから rotate」は毎回確実に
中止します（`resolveCurrentUiToken()` は書き換え対象のトークンファイルより env を権威として
優先するため。中止時に表示されるメッセージも参照）。`rotate` はこの変数が **未設定の状態**
（`operator.env` を source していない新しいシェル）で実行するか、明示的に unset してください。

```bash
env -u AZITO_UI_TOKEN azito token rotate
```

`~/.azito/azitoctl*.env`（`azitoctl` / `azs` が source する、タスク実行プロセスや hook スクリプト
向けのファイル）には `AZITO_UI_TOKEN` は一切書かれません。もしこれらのファイルに
`AZITO_UI_TOKEN=` 行が残っていたら、この変更より前の `setup.sh` が書いた残留物です。`setup.sh`
を再実行すれば（ファイル全体を書き直すため）自動的に消えます。`azito auth doctor` で確認できます。

### `azito auth doctor`

**ハブ上で**実行し、意図した状態からのズレを検査します。

```bash
azito auth doctor
```

(a)-(d), (f) は**実行したマシンのローカルファイル・env のみ**を検査します。(e) だけは例外で、
ハブの DB に登録された**全サーバー**（ローカル・agent 問わず）を、そのサーバーの transport
経由で横断的に検査します（後述）。そのため、このコマンドは**ハブの DB を持つホスト**（通常は
ハブそのもの）で実行してください。ハブでないホストで実行した場合、(e) は検査自体ができない旨を
案内します。

- (a) `~/.azito/azitoctl*.env` に `AZITO_UI_TOKEN` 行が残っていないか
- (b) `~/.azito/operator.env`（存在する場合）のパーミッションが 0600 か
- (c) `~/.claude/settings.json` の MCP トークン（存在する場合）が、ローカルで読める範囲で
  ハブの現在のトークンと一致するか
- (d) Codex 側の `azt-mcp` トークンがハブの現在値と一致するか（`codex` CLI がある場合のみ）
- (e) `AZITO_SCOPED_AUTH` が**まだ未有効**のときだけ: ハブの DB に登録された全サーバー上に
  生存中のタスク所有 tmux ペインが残っていないか（§ 移行手順の Step 4 前のドレイン確認 —
  検査結果は「NG」ではなく「!!」（警告）として表示されます。フラグ OFF の間はこの状態自体は
  正常で、有効化を予定している場合にのみ意味を持つ案内だからです）。見つかった場合は、それらの
  タスクを終端させるか再生成してから有効化してください — 互換モードで作られたペインは
  env に `AZITO_UI_TOKEN` を保持したまま残り、フラグ ON 後もそのペインからは operator
  相当の操作ができてしまいます。**到達できないサーバー（停止中・トークン不一致・
  ネットワーク不通など）は「NG」でも「green」でもなく「--」（検証不能）として報告されます** —
  「未確認」が誤って「clean」として扱われることはありません。
- (f) `AZITO_SCOPED_AUTH` の現在値

失敗した項目（NG）には修正手順が表示されます。

### 同一 UNIX ユーザーであることの限界

この分離は**行儀の良いコードパス同士の権限境界**であり、サンドボックスではありません。
`chmod 600` は*別の UNIX ユーザー*からの読み取りを防ぐだけで、同じユーザーで動く別プロセスが
直接ファイルを読む、`/proc/<pid>/environ` を辿る、ptrace する、といった経路には無力です。
タスクワーカーが攻撃者に制御されたコードを実行した場合、そのコードは `~/.claude/settings.json`
や兄弟プロセスの環境変数など、この UNIX ユーザーが読めるものすべてを読めます — 原理的には
`operator.env` も、もしタスク側のシェルがそれを継承したり読んだりすれば同様です（だからこそ
どこからも自動 source しません）。**悪意あるコード**からの隔離（**行儀の良いコード**のアクセス
構造化とは別物）はここでの対象外であり、別イシュー（#29、OS レベルの隔離）で扱います。同様に、
この Phase が書く監査ログは運用上のデバッグ・レビュー記録であり、改ざん耐性は主張しません。

### 移行手順（段階的活性化）

新ハブは**互換モード**で出荷されます。裏では task トークンを注入しつつ、旧来の UI トークン
のみの経路も引き続き受け付けるため、移行途中で壊れることはありません。以下の順で進めてください。

1. **先に修正済み CLI を配布する。** どのサーバーの harness にも触れる前に、ハブの
   `packages/server` コード（またはリリースビルド）を更新し、`azito token rotate` と
   `azito auth doctor` を使える状態にします。
2. **各サーバーの harness を更新する。** これまでと同じ引数で `setup.sh` を再実行します。
   `azitoctl*.env` への `AZITO_UI_TOKEN` 書き込みが止まり、`--ui-token` を渡していれば
   代わりに `operator.env` が書かれます。Phase A で `AZITO_TASK_TOKEN` フォールバックが
   `azt-*` スキルに入っているため、サーバーごとに順次実施して問題ありません。
3. **ハブ自体を更新する**（まだ互換モード）。ハブ再起動時に実行中だったタスクは自然終端する
   か、再生成が必要になります（kill する必要はありませんが、ペイン env は再起動前の状態の
   ままです）。
4. **`AZITO_SCOPED_AUTH` を有効化する。** ハブ上で `azito auth doctor` を実行し、全サーバーが
   green（または該当なし）になってから切り替えます。この時点で初めて、task principal が
   実際に allowlist 済み API（設計 §4）のみに制限されます（それまでは scoped トークンが
   *発行*されるだけです）。

   **切り替え直前にドレインすること。** 互換モードで作られたタスクペインは env に
   `AZITO_UI_TOKEN` を保持したまま生き続けるため、フラグを ON にしても、その時点で
   まだ生きているペインからは operator 相当の操作が引き続き可能です。`azito auth doctor`
   の「生存中のタスク所有ウィンドウ」検査（上記 (e)）が警告を出す場合は、フラグを
   ON にする前に、該当タスクを完了させるか再生成してください。この検査は**ハブ上で
   実行すれば全サーバーを一括で検査します**（ローカル・agent 問わず）。到達できない
   サーバーがあれば「検証不能」として個別に報告されるので、そのサーバーの状態
   （起動しているか、agent トークンが最新か等）を確認してから再実行してください。

   同時に supervisor 登録の扱いも変わります（設計 §8）。タスク実行が起動する
   `tui-supervisor` はハブが発行した `--launch-id`/`--bootstrap-token` を伴って登録し、
   申告した serverName/target/taskId/unitId がハブの記録と一致した場合のみ **bound**
   （ダッシュボードの活動表示・タスク turn のアイドルタイマー更新・
   AgentActivityMonitor の最優先シグナルを駆動する対象）として扱われます。
   一方、`azito auth doctor` の起動ログや手動デバッグで `azs`（tui-supervisor の裸起動）
   を直接叩いた場合は `--launch-id` を持たないため、登録自体は引き続き受理されますが
   **unbound**（表示専用）になります。unbound な接続は turn のアイドルタイマーや
   Tier 0 活動判定には一切影響しません — フラグ ON 以前と違って「手動 azs もタスクの
   活動として扱われる」ことはなくなる点に注意してください。フラグ OFF の間は
   このダウングレードは発生せず、`--launch-id` の有無に関わらず常に bound 扱いです
   （挙動不変）。
5. **最後に UI トークンをローテートする。** `azito token rotate` を実行し、ブラウザ（トークン
   再入力）・自動更新が届かなかった MCP クライアント設定・他の operator 用マシンの
   `operator.env` を更新します。**この最後の rotate は、ドレインしきれずに残ってしまった
   ペイン内の旧トークンを最終的に無効化する役割も兼ねます** — rotate はハブが受理する
   UI トークンそのものを変えるため、Step 4 のドレイン確認をすり抜けて残ったペインが
   あっても、そのペインが保持している旧トークンはこの時点で使えなくなります。

---

## 既存環境の移行手順

所要時間の目安は 15〜30 分です。順番に実行してください。

### Step 0. バックアップ

```bash
cd <azito>
cp data.db "data.db.bak-$(date +%Y%m%d-%H%M%S)"
cp packages/server/.env packages/server/.env.bak 2>/dev/null || true
```

### Step 1. コードを取得する

```bash
git fetch origin
git checkout master && git pull --ff-only origin master
npm ci
```

`npm ci` を使うのは、更新された `package-lock.json`（`@fastify/static` の脆弱性修正を含む）に正確に揃えるためです。

### Step 2. サーバーの環境変数を設定する

> `AZITO_UI_TOKEN` を設定しなくても、初回起動時に自動生成されます（リリース版: `azito token show`、ソース版: `packages/server/.env` または `data/ui-token`）。固定トークンを使いたい場合のみ以下の手順で設定してください。

```bash
openssl rand -hex 32   # 出力をコピー
```

`packages/server/.env` に追記します。

```bash
AZITO_UI_TOKEN=<上で生成した64文字>

# Tailscale 経由でアクセスする場合のみ（IP は `tailscale ip -4` で確認）
AZITO_BIND=100.x.y.z
AZITO_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3001,http://<tailscale-host>:3001
```

権限を絞ります。

```bash
chmod 600 packages/server/.env
```

> `AZITO_BIND` を設定しない場合、`127.0.0.1` のみで待ち受けます。同じマシンのブラウザからしかアクセスできなくなるので、リモートから使っているなら必ず設定してください。

### Step 3. MinIO の資格情報を設定して作り直す

これまで既定値（`minioadmin` / `minioadmin`）で全ネットワークインターフェースに公開されていたため、**資格情報のローテーションを推奨します**。

```bash
# 十分に長い値を生成
openssl rand -hex 24   # ユーザー名用
openssl rand -hex 32   # パスワード用
```

リポジトリルートの `.env` に設定します。

```bash
MINIO_ROOT_USER=<生成した値>
MINIO_ROOT_PASSWORD=<生成した値>
```

```bash
chmod 600 .env
docker compose down
docker compose up -d
```

ポートは `127.0.0.1:9000` / `127.0.0.1:9001` に限定されました。リモートから MinIO コンソールを見る場合は SSH ポートフォワードか Tailscale の設定を使ってください。

設定後、AZITO の Settings → Storage で新しい資格情報を登録し直します。

### Step 4. 既存の秘密情報を暗号化する

サーバー初回起動時に `data/master.key` が自動生成されます。既存の平文データは透過的に読めますが、一括で暗号化しておきます。

```bash
npm run dev   # 一度起動して data/master.key を生成させ、Ctrl+C で停止
npx tsx scripts/seal-existing-secrets.ts
```

出力例:

```
Sealing existing secrets...
  llm_providers.api_key: 2
  servers.agent_token: 2
  project_repositories.token: 0
  project_secrets.value: 5
  storage_settings.access_key/secret_key: 1
Done.
```

**`data/master.key` を必ずバックアップしてください。** 紛失すると暗号化済みの秘密情報（LLM API キー・agent token・project secret・リポジトリ token・MinIO 資格情報）が復号不能になります。

```bash
cp data/master.key ~/secure-backup/azito-master.key   # 安全な場所へ
```

### Step 5. 永続ファイルの権限を確認する

起動時に自動で `600` に設定されますが、確認しておきます。

```bash
stat -c '%a %n' data.db data.db-wal data/vapid-keys.json data/master.key 2>/dev/null
# すべて 600 であること
```

### Step 6. 起動してトークンを入力する

```bash
npm run dev
```

`http://localhost:5173`（または `http://<tailscale-host>:3001`）を開くとトークン入力画面が表示されます。Step 2 で生成した `AZITO_UI_TOKEN` を入力してください。

> トークンは `sessionStorage` に保存されるため、**ブラウザのセッションごと（タブを閉じるまで）** 有効です。新しいセッションでは再入力が必要です。

### Step 7. harness を再セットアップする（全サーバー）

harness のトークン配送方式が変わったため、これを実行しないと `/azt-*` スキルの API 呼び出しが 401 になります。

```bash
# ローカル
./harness/setup.sh \
  --azito-url http://localhost:3001 \
  --webhook-token "$AZITO_WEBHOOK_TOKEN" \
  --ui-token "$AZITO_UI_TOKEN" \
  --server-name local
```

> **3つのオプションをすべて渡してください。** `~/.azito/azitoctl.env`（mode 600）は `--azito-url` と `--webhook-token` の両方が指定されたときにのみ書き出され、`--ui-token` はそこに追記されます。`--ui-token` だけでは書き出されません。

リモートサーバーでは、そのサーバー上で同じコマンドを実行します（`--azito-url` はハブの URL、`--server-name` はそのサーバーの AZITO 上の名前）。

```bash
ssh <remote-host>
cd <azito>   # harness が配置されているパス
./harness/setup.sh --azito-url http://<hub>:3001 --webhook-token <token> --ui-token <token> --server-name "The Mirano"
```

### Step 8. agent サーバーを再インストールする（推奨・任意）

agent の token が systemd unit への平文埋め込みから mode 600 の `EnvironmentFile` 方式に変わりました。既存 agent は旧形式のまま動作するので急ぎではありませんが、移行を推奨します。

AZITO の Servers → 対象サーバー → Setup → Agent Server の「Reinstall」から実行できます。再インストールすると agent token も新しくなります。

### Step 9. 検証

```bash
# 認証が効いていること
curl -s -o /dev/null -w 'no-auth: %{http_code}\n' http://127.0.0.1:3001/api/servers
# → 401

curl -s -o /dev/null -w 'with-auth: %{http_code}\n' \
  -H "Authorization: Bearer $AZITO_UI_TOKEN" http://127.0.0.1:3001/api/servers
# → 200

# CORS がワイルドカードでないこと
curl -s -D - -o /dev/null -H 'Origin: https://evil.example' http://127.0.0.1:3001/api/servers | grep -i access-control-allow-origin
# → 何も出ない（または許可オリジンのみ）
```

UI 側は次を確認します。

- [ ] トークン入力後にワークスペースが表示される
- [ ] ターミナルタブが接続できる（WebSocket 認証の確認）
- [ ] タスクを1件実行して planning まで進む（harness トークン配送の確認）
- [ ] ファイルエクスプローラーでファイルが開ける
- [ ] エージェント完了通知が届く（webhook トークンの確認）

---

## 新規開発環境の構築手順

### 前提条件

| ソフトウェア | バージョン | 用途 |
|---|---|---|
| Node.js | v24 以上 | バックエンド・フロントエンド実行 |
| tmux | 3.4 以上 | ターミナルセッション管理 |
| Docker | 最新推奨 | MinIO（ファイルストレージ、任意） |
| Tailscale | 最新推奨 | HTTPS / プッシュ通知 / SSH 接続（任意） |
| OpenSSL | 任意のもの | トークン生成 |

コーディングエージェントを使う場合は `claude` / `codex` コマンドも必要です。

### 1. 取得とインストール

```bash
git clone <repository-url> azito
cd azito
npm ci
```

### 2. サーバーの環境変数を作成する

> `AZITO_UI_TOKEN` を設定しなくても、初回起動時に自動生成されます（リリース版: `azito token show`、ソース版: `packages/server/.env` または `data/ui-token`）。固定トークンを使いたい場合のみ以下で設定してください。

```bash
cat > packages/server/.env <<EOF
AZITO_UI_TOKEN=$(openssl rand -hex 32)
AZITO_WEBHOOK_TOKEN=$(openssl rand -hex 32)
EOF
chmod 600 packages/server/.env
cat packages/server/.env   # トークンを控える（ブラウザ入力と harness で使う）
```

`AZITO_WEBHOOK_TOKEN` は省略可（起動ごとにランダム生成）ですが、harness と共有する必要があるため固定しておくと運用が楽です。

### 3. MinIO を使う場合（任意）

```bash
cat > .env <<EOF
MINIO_ROOT_USER=$(openssl rand -hex 24)
MINIO_ROOT_PASSWORD=$(openssl rand -hex 32)
EOF
chmod 600 .env
docker compose up -d
```

ファイルストレージ機能を使わないならこの手順は不要です（AZITO 本体は MinIO なしで動作します）。

### 4. 起動する

```bash
npm run dev
```

- バックエンド: `http://127.0.0.1:3001`
- フロントエンド（Vite）: `http://localhost:5173`

ブラウザで `http://localhost:5173` を開き、`AZITO_UI_TOKEN` を入力します。

### 5. harness を導入する

```bash
source packages/server/.env   # トークンを読み込む
./harness/setup.sh \
  --azito-url http://localhost:3001 \
  --webhook-token "$AZITO_WEBHOOK_TOKEN" \
  --ui-token "$AZITO_UI_TOKEN" \
  --server-name local
```

### 6. 初期セットアップ

1. **サーバーの確認** -- 既定で `local` サーバーが登録されています
2. **プロジェクトの作成** -- Projects からプロジェクトを作成し、ワーキングディレクトリを設定
3. **Unit の設定** -- タスクの進め方と実行ランタイムを定義
4. **依存の導入確認** -- Servers → 対象サーバー → Setup で tmux / Node.js / harness の状態を確認

詳細は [ユーザーガイド](./README.md) と [azt-harness ガイド](./harness.md) を参照してください。

---

## Tailscale 経由でアクセスする場合

**構成によって必要な設定が変わります。** まず自分がどちらかを確認してください。

```bash
tailscale serve status
```

### 構成A: `tailscale serve` で HTTPS 終端する（推奨・出力に proxy 行がある場合）

```
https://<host>.ts.net (tailnet only)
|-- / proxy http://localhost:5173
```

この構成では通信が **すべて localhost で終端** します。ブラウザ → Tailscale(HTTPS) → `localhost:5173`(Vite) → `localhost:3001`(AZITO) という経路なので、**`AZITO_BIND` は既定の `127.0.0.1` のままで正しく、変更してはいけません**（変更すると Vite のプロキシ先 `localhost:3001` が届かなくなります）。

必要なのは許可オリジンの追加だけです。`packages/server/.env`:

```bash
AZITO_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3001,https://<host>.ts.net
AZITO_PUBLIC_URL=https://<host>.ts.net
```

`AZITO_PUBLIC_URL` は supervisor やリモートエージェントがハブへ到達するための URL です。省略すると Tailscale IP（`http://100.x.x.x:3001`）が使われますが、`127.0.0.1` bind ではこのアドレスに到達できず、**supervised 監視が機能しません**。`tailscale serve` 構成では必ず MagicDNS の HTTPS URL を設定してください。

ブラウザが送る `Origin` は Tailscale の HTTPS ドメインなので、これを追加しないと API が CORS で拒否され、WebSocket も `1008 Forbidden origin` で切断されます。

Vite 側は `.ts.net` を既定で許可しているため設定不要です（`allowedHosts` に `.ts.net` が入っています）。別ドメインを使う場合のみ `AZITO_ALLOWED_HOSTS` に追加してください。

```bash
AZITO_ALLOWED_HOSTS=my-host.example.com npm run dev
```

### 構成B: Tailscale IP に直接アクセスする（`tailscale serve` を使わない場合）

AZITO を Tailscale IP で待ち受けさせます。`packages/server/.env`:

```bash
AZITO_BIND=100.101.102.103          # tailscale ip -4 の出力
AZITO_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3001,http://<host>.ts.net:3001
```

この構成では `localhost:3001` で待ち受けなくなるため、**Vite 開発サーバーのプロキシ（`localhost:3001` 宛て）が動きません**。`npm run dev` ではなく本番デーモン（`:3001` がビルド済みフロントエンドを同一オリジンで配信）を使ってください。

```bash
npm run build && systemctl --user restart azito
```

### 設定後の確認

```bash
# CORS が Tailscale オリジンを許可しているか
curl -s -D - -o /dev/null -H "Origin: https://<host>.ts.net" \
  http://127.0.0.1:3001/api/health | grep -i access-control-allow-origin
# → access-control-allow-origin: https://<host>.ts.net

# 未許可オリジンが拒否されるか（何も出なければ正しい）
curl -s -D - -o /dev/null -H "Origin: https://evil.example" \
  http://127.0.0.1:3001/api/health | grep -i access-control-allow-origin
```

`.env` を変更したら、`tsx watch` はソース変更時に再読み込みするため `touch packages/server/src/main.ts` で反映できます（デーモン運用時は `systemctl --user restart azito`）。

---

## 本番（デーモン）運用

```bash
./deploy/daemon-install.sh          # ビルド + systemd user unit 登録 + 起動
systemctl --user status azito
journalctl --user -u azito -f
```

`deploy/azito.service` は `EnvironmentFile=-<root>/packages/server/.env` を読みます。したがって `AZITO_UI_TOKEN` と `AZITO_BIND` は `packages/server/.env` に置いておけばデーモンにも渡ります。

コード更新後の反映:

```bash
npm run build && systemctl --user restart azito
```

開発サーバーとデーモンは同じ `:3001` を使うため、`npm run dev` を使う前にデーモンを停止してください。

```bash
systemctl --user stop azito
# 開発終了後
systemctl --user start azito
```

---

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| UI トークンが分からない | 自動生成されたトークンの確認方法 | リリース版: `azito token show`。ソース版: `grep AZITO_UI_TOKEN packages/server/.env` または `cat data/ui-token` |
| `AZITO_BIND must not be 0.0.0.0 or ::` で落ちる | 全インターフェース bind は明示的に禁止 | `127.0.0.1` か Tailscale IP を指定 |
| ブラウザからアクセスできない（接続拒否） | `127.0.0.1` のみで待ち受けている | `AZITO_BIND` に Tailscale IP を設定して再起動 |
| UI が API 401 のままループする | 入力トークンがサーバーの値と不一致 | `packages/server/.env` の値を確認。ブラウザのセッションを閉じて再入力 |
| ターミナルタブが即切断される（`1008 Unauthorized`） | WebSocket にトークンが載っていない | ブラウザをリロード。古いタブが残っている場合は閉じる |
| ターミナルが `1008 Forbidden origin` で切断される | アクセス元オリジンが未許可 | `AZITO_ALLOWED_ORIGINS` にそのオリジンを追加して再起動 |
| Vite が `Blocked request. This host is not allowed` を返す | `allowedHosts` に未登録 | `vite.config.ts` にホスト名を追加、または `:3001` を使う |
| `/azt-*` スキルが 401 になる | harness のトークン未配布 | `setup.sh` を `--azito-url` `--webhook-token` `--ui-token` の3つ付きで再実行 |
| `docker compose up` が `MINIO_ROOT_USER is required` で失敗 | ルートの `.env` 未設定 | ルート `.env` に資格情報を設定 |
| MinIO コンソールにリモートから繋がらない | ポートが `127.0.0.1` 限定になった | SSH ポートフォワード（`ssh -L 9001:127.0.0.1:9001 <host>`）を使う |
| タスク実行が `Unsafe branchName` / `Invalid base_branch` で失敗 | ブランチ名・パスに使用不可の文字が含まれる | 英数字と `_ . / -`（パスは `@ : ~` も可）のみを使う |
| ファイルプレビューが `Not a regular file` になる | 通常ファイル以外（デバイス・FIFO 等）を開いた | 通常ファイルを選択する。プレビュー不可は仕様 |
| カスタム LLM provider の保存が 400 になる | `base_url` が HTTPS でない、または private / loopback / Tailscale CGNAT（100.64.0.0/10）を指している | 公開 HTTPS エンドポイントを使う。tailnet 上のエンドポイントが必要な場合は `shared/validation/urlValidation.ts` の緩和が必要 |
| provider 更新が `api_key must be re-entered when base_url changes` で 400 | エンドポイント変更時のキー流出防止 | API キーを再入力して保存する |
| SSH 接続が `Host key mismatch` で失敗 | 保存済み fingerprint と不一致（サーバー再構築 or 中間者攻撃） | 意図した変更なら Servers → 対象サーバー → Danger Zone で「SSH fingerprint をリセット」 |
| agent サーバーが全 API 401 | agent token 不一致 | Servers → Setup → Agent Server の「Reinstall」で再配備 |
| supervised ペインを開くたびに 10 秒待ちになる | `AZITO_PUBLIC_URL` 未設定で Tailscale IP が使われているが `127.0.0.1` bind のため到達不能 | `.env` に `AZITO_PUBLIC_URL=https://<MagicDNS名>` を追記 → サービス再起動 → supervised ウィンドウを respawn（既存ペインのシェルは古い `AZITO_URL` を保持するため respawn 必須。`GET /api/supervisors` が `[]` なら本問題） |
| `azito auth doctor` が `azitoctl*.env に AZITO_UI_TOKEN が残っています` を報告する | 旧バージョンの `setup.sh` が書いた行が残っている | 同じ `--azito-url` `--webhook-token` で `setup.sh` を再実行（ファイルは毎回丸ごと書き直されるため自動的に消える） |
| `azito auth doctor` が MCP settings のトークン不一致を報告する | `azito token rotate` 後に MCP 設定へ反映されていない、または別サーバーで rotate した | `harness/setup.sh --ui-token <最新トークン>` を再実行するか、operator.env を最新化してから `azito token rotate` を再実行 |

## 復旧（ロールバック）

### `data/master.key` を紛失した場合

暗号化済みの秘密情報は復号できません。次の値を手動で再設定してください。

1. Settings → Providers で LLM API キーを再入力
2. Settings → Storage で MinIO 資格情報を再入力
3. 各プロジェクトの Secrets を再登録
4. 各リポジトリの token を再登録
5. agent サーバーを再インストール（token 再発行）

再設定前に、旧 `master.key` が別の場所に残っていないか確認してください（バックアップ・`data.db.bak-*` と同じディレクトリなど）。

### 変更前のバージョンに戻す場合

```bash
systemctl --user stop azito        # デーモン運用時
git checkout <変更前のコミット>
npm ci
cp data.db.bak-<timestamp> data.db  # Step 0 で取ったバックアップ
```

DB スキーマの追加（`servers.ssh_host_fingerprint`）は旧コードでも無害なので、DB を戻さずに動かすこともできます。ただし暗号化済みの秘密カラムは旧コードでは復号されないため、`data.db` のバックアップから戻すのが確実です。

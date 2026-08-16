# 隔離実行プロファイル（Issue #29）

## この文書の位置づけ

外部由来（イシュー本文・PR コメントなど、operator が直接書いたわけではない）のタスク指示を
実行する際、ワーカーに操作されたコードが operator 相当の資格情報へ到達できてしまうと、
プロンプトインジェクション経由でハブ全体・他サーバー・リポジトリの書き込み権限まで奪われ
得ます。**隔離実行プロファイル**は、そうした外部入力タスクを「資格情報を一切持たないサーバー」
の上でだけ動かすための宣言・検証・実行時ゲートの仕組みです。

主体分離（operator/task principal の分離、scoped auth）そのものについては
[セキュリティ設定・環境構築ガイド](./security-setup.md) を参照してください。本文書はその上に
積む、OS レベルの隔離（Issue #29）を扱います。

## 1. 隔離実行とは / 3層モデル

隔離は単一の仕組みではなく、性質の異なる3層の組み合わせです。

| 層 | 内容 | 実装状況 |
|---|---|---|
| 層1: OS 境界 | 隔離対象サーバーそのものに、operator 相当の資格情報（SSH秘密鍵、gh 認証、operator トークン、ハブの秘密情報）を**そもそも置かない**構成にする | 運用（サーバー構築時の選択） |
| 層2: 配布遮断 | ハブが、隔離を宣言したサーバー宛のタスクペインに operator 相当のトークンを**注入しない** | 実装済み（`TaskPaneEnvironmentService`） |
| 層3: API 認可 | scoped auth により、task principal が使える API を allowlist 済みのものだけに制限する | Issue #28 で実装済み。隔離宣言の**前提条件**として必須 |

「isolation doctor」（後述）は、既知の資格情報残留箇所（ファイル・環境変数・`gh`/git 設定・
ssh-agent フォワード）を対象ホスト上の自己申告で確認する健全性チェックです。**層2が全経路で
効いていることを end-to-end に検証するものではありません**。特に、実際のタスク実行が使う
tmux ペインの実行環境（`TaskPaneEnvironmentService` によるマスクが適用される場所）は doctor の
検査対象に含まれません — タスクウィンドウ作成の配線にリグレッションが入り、そのマスクが
新規タスクウィンドウへ届かなくなっても、doctor は green のまま気づけません。層1は運用上の
構成そのものであり、doctor は「doctor が把握している既知の箇所」が意図どおりかを**確認**する
立場にあり、構成自体を強制するものでも、層2が依存する全箇所をカバーするものでもありません。

C-1（層3が前提）の帰結として、**`isolation_intent` を有効化する PUT は、scoped auth
（`AZITO_SCOPED_AUTH=1`）が有効なハブでなければ 409 で拒否されます**（後述）。

## 2. 隔離サーバーの構築手順

隔離実行の対象にできるのは `agent` 型サーバーのみです（`local`/`ssh` は対象外）。

### 前提条件

1. 対象サーバーに SSH 秘密鍵・`gh` 認証・operator トークン・ハブの秘密情報（`AZITO_UI_TOKEN`
   等）を一切配置しない構成でセットアップする。
2. ハブ側で scoped auth を先に有効化しておく（順序が重要 — 下記参照）。

### 有効化の順序

1. **scoped auth の doctor を green にする。** `azito auth doctor` を実行し、全サーバーが
   green（または該当なし）になることを確認する。手順は
   [セキュリティ設定・環境構築ガイド](./security-setup.md#azito-auth-doctor) を参照。
2. **`AZITO_SCOPED_AUTH=1` を有効化する。** ハブを再起動する。
3. **`azito token rotate` を実行する。** ドレインしきれず残ったペインの旧トークンを無効化する
   （詳細は security-setup.md の移行手順を参照）。
4. **隔離サーバーを構築する。** `harness/setup.sh --purge-operator-token` を使って harness を
   導入する（下記参照）。
5. **隔離を宣言する。** `PUT /api/servers/:name` に `isolationIntent: true` を送る。

この順序を逆にする（scoped auth が無効なまま隔離を宣言しようとする）と、PUT は
`isolation_intent_requires_scoped_auth`（409）で拒否されます。

### `setup.sh --purge-operator-token`

`harness/setup.sh` に `--purge-operator-token` を渡すと、そのサーバー上に残っている
operator 相当のトークンを積極的に除去します。

- `~/.azito/operator.env` を削除する（存在すれば）
- `~/.claude/settings.json` の `mcpServers.azt-mcp.env` から `AZITO_UI_TOKEN` を除去する
- Codex の `config.toml`（`mcp_servers.azt-mcp.env`）から `AZITO_UI_TOKEN` を除去する
- `--ui-token` と同時指定はできない（トークンを配りながら除去するのは矛盾するため、`setup.sh`
  自身がエラーで拒否する）

隔離宣言（`isolationIntent: true` への false→true 遷移）が成功すると、ハブはこのクリーンアップを
自動的に一度実行しようとします（`isolationCleanup: 'done' | 'failed' | 'skipped'` として PUT の
応答に含まれる）。失敗した場合は `isolation_cleanup_report` に理由が記録され、true→true の
再送信（リトライ）で再実行できます。

## 3. isolation doctor

`POST /api/servers/:name/isolation/doctor` は、隔離を宣言済みの `agent` 型サーバーに対して、
実際に資格情報が届いていないかをプローブする9つの検査を実行します。

| check id | 検出する設定ミス |
|---|---|
| `same_host` | 対象サーバーがハブと同一ホスト/同一ファイルシステムである（hostname/uid 一致 + カナリアファイル読み取り） |
| `no_ssh_private_keys` | `~/.ssh` 配下に PEM 形式の秘密鍵が残っている |
| `gh_unauthenticated` | `gh` にローカル資格情報（`hosts.yml` のトークン、`GH_TOKEN`/`GITHUB_TOKEN`/`GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` 環境変数）が残っている |
| `no_git_credentials` | `git config credential.helper` に実効設定がある、または `~/.git-credentials` が存在する |
| `no_operator_token` | `~/.azito/azitoctl*.env` または `operator.env` に `AZITO_UI_TOKEN=` 行が残っている |
| `no_claude_mcp_token` | `~/.claude/settings.json` の `mcpServers.azt-mcp.env` に `AZITO_UI_TOKEN` が残っている |
| `no_codex_mcp_token` | Codex の `config.toml` の `mcp_servers.azt-mcp.env` に `AZITO_UI_TOKEN` が残っている |
| `no_operator_environment` | `/api/exec` が起動する実行環境（プロセス継承環境）に `AZITO_UI_TOKEN`/`AZITO_WEBHOOK_TOKEN`/`AZITO_MASTER_KEY` のいずれかが存在する（`AZITO_AGENT_TOKEN` はハブ↔agent間の輸送資格情報であり対象外） |
| `no_ssh_agent` | forward された `SSH_AUTH_SOCK` 経由で認証可能な ssh-agent が到達可能である |

各 check は `pass` / `fail` / `unknown` の3値で、`verified` は**全 check が `pass` の場合のみ**
`true` になります。プローブ不能（到達不能・想定外の出力形式など）は `unknown` に倒し、
`pass` へ丸め込むことはありません（fail-closed）。

### ドクトリン: doctor は設定ミス検出器であり attestation ではない

isolation doctor のプローブはすべて、対象ホスト上で動く agent プロセスへの
`transport.exec()` 経由の自己申告に依存しています。対象ホストが敵対的である場合
（たとえば、隔離サーバー上で実行された外部入力タスクがすでに agent プロセスやその実行環境を
改ざんしている場合）、このファイルのどの検査も、また将来追加されるどの検査も、その自己申告を
信頼できません。

敵対的ホストに対する実際の防御は構造的なものであり、プローブベースではありません:
そのホストには、そもそも盗む価値のある資格情報を**配布しない**（層2の配布遮断ゲート）。
isolation doctor の役割は、その構造的なゲートが「operator が期待している状態」に実際に
なっているかを確認する健全性チェックであって、ゲートが対象にしていないホストに対する
代替の保証ではありません。

**検査範囲の注記**: 上表の9 check は、資格情報が残留しうる既知の箇所（ファイル・環境変数・
`gh`/git 設定・ssh-agent フォワード）を列挙したものです。実際のタスク実行が使う **tmux
ペインの実行環境**（`TaskPaneEnvironmentService` がウィンドウ作成時にマスクを適用する場所）は
これらの検査のどれも通しません。そのため、この doctor は「既知の箇所」の健全性チェックの
スナップショットであり、あるタスク実行における層2経路全体が無傷であることの証明では
ありません。

### verified の TTL と doctor 失敗時の即時無効化

doctor が全 check `pass` で完了すると、`isolationVerifiedAt` が記録され、以後
**24時間**（`ISOLATION_VERIFICATION_TTL_MS`）はこの検証が「有効」として扱われます。TTL を
過ぎた検証は自動的に無効化されます（4節参照）。

doctor の実行が1つでも `fail`/`unknown` を含んで完了した場合、`isolationVerifiedAt` は
**即座に**クリアされます（古い verified の残留を防ぐ）。

## 4. allow ポリシーと実行時再検証

プロジェクト＋サーバーの組ごとに、外部由来（untrusted-origin）タスクの実行ポリシーを
`deny` / `manual-approval` / `allow` から選べます。`allow` は承認なしで自動実行する
最も緩いポリシーです。

`allow` が実際に有効になるのは、以下の**3点 AND** をタスク実行のたびにサーバー側で
再評価し、すべて満たしている場合のみです。

1. 対象サーバーが `isolationIntent: true` を宣言している
2. その隔離が isolation doctor によって検証済みであり、`ISOLATION_VERIFICATION_TTL_MS`
   （24時間）以内である
3. scoped auth（`AZITO_SCOPED_AUTH`）がこのハブプロセスで有効である

いずれか1つでも崩れていれば、`allow` は自動的に `manual-approval` へ降格します
（`deny` へは絶対に降格しません — エラーにもしません）。降格理由は以下のいずれかです。

| 降格理由 | 意味 |
|---|---|
| `not_isolated` | サーバーが隔離を宣言していない |
| `verification_missing` | isolation doctor による検証が一度も成功していない |
| `verification_expired` | 検証済みだが TTL（24時間）を超過している |
| `verification_failed` | `isolationVerifiedAt` はあるが対応する検証レポートが `verified: true` でない（防御的二重チェック） |
| `scoped_auth_disabled` | scoped auth がこのハブで無効になっている |

## 5. 限界の明示（TOCTOU・自己申告）

- **スナップショット性**: isolation doctor の結果はプローブ実行時点のスナップショットです。
  プローブが完了した直後に対象サーバーへ資格情報が書き込まれても、doctor はそれを検出
  できません（TOCTOU: Time-of-check to time-of-use）。24時間の TTL はこのギャップを縮小
  しますが、ゼロにはしません。
- **自己申告への依存**: 3節のドクトリンのとおり、doctor のプローブは対象ホスト自身の応答に
  依存します。敵対的ホストは自己申告を偽装しうるため、doctor は「構造的なゲート（層2）が
  効いているか」の健全性確認であり、敵対的ホストそのものへの対策ではありません。
- **tailnet メンバーシップは対象外**: Tailscale SSH による横移動の可否（tailnet 上でどの
  ホストへ到達できるか）は、ハブから実行される per-server のプローブでは観測も強制も
  できません。isolation doctor の対象外であり、tailnet ACL / ファイアウォールの運用責任
  です（6節参照）。

## 6. ネットワーク隔離（横移動対策）

隔離サーバー自体に資格情報を置かなくても、そのサーバーが tailnet 上の他ホストへ SSH で
到達できてしまうと、横移動の踏み台にされ得ます。ネットワークレベルでの隔離を必ず併用して
ください。

### tailnet ACL 規律版（Tailscale 使用時）

**適用範囲の限定**: Tailscale ACL が制御できるのは tailnet オーバーレイ経由のトラフィック
（Tailscale が割り当てた IP / MagicDNS 名宛の通信）だけです。public internet への直接到達や
同一 LAN セグメント上の他ホストへの到達は ACL の対象外であり、ACL だけでは横移動対策として
不十分です。下記の ACL 例はあくまで「tailnet 内での SSH 横移動」を塞ぐものであり、
public/LAN 経路の遮断には次項の恒常的なホストファイアウォールが別途必要です。

隔離サーバーに `tag:isolated` を付与し、その tag からの Tailscale SSH を全宛先で拒否、
outbound はハブの webhook ポートのみ許可する ACL 例:

```jsonc
{
  "tagOwners": {
    "tag:isolated": ["autogroup:admin"],
  },
  "acls": [
    // 隔離サーバーからの outbound は、ハブの webhook ポートのみ許可
    { "action": "accept", "src": ["tag:isolated"], "dst": ["<hub-tailscale-ip>:3001"] },
    // それ以外の隔離サーバー発の通信は暗黙 deny（allowlist 方式）
  ],
  "ssh": [
    // 隔離サーバー "への" SSH は運用上必要な範囲でのみ許可（別途定義）
    // 隔離サーバー "からの" SSH は明示的に許可しない = 事実上の全宛先 deny
  ],
}
```

ポイントは、`tag:isolated` を **src** とする SSH ルールを一切書かないことです。Tailscale の
`ssh` ブロックは明示的に許可されたペアのみを通すため、`tag:isolated` からの SSH を許可する
エントリが無ければ、そのタグを持つホストから他ホストへの SSH は成立しません。

### ファイアウォール版（永続的なホストファイアウォールとして必須）

Tailscale ACL は tailnet 宛のトラフィックしか制御しないため（前項）、public internet 直接到達
・同一 LAN・IPv6 経路での横移動を塞ぐには、隔離サーバー本体に**恒常的な** dual-stack（IPv4 +
IPv6）のホストファイアウォールが別途必要です。Tailscale 使用の有無に関わらず、tailnet ACL の
補完として常時適用してください。

`iptables` は IPv4 のみを対象とするため、`ip6tables` を省略すると **IPv6 の egress が素通り**
します。IPv4/IPv6 を一体で書ける `nftables` を推奨しますが、`iptables`/`ip6tables` の組でも
同内容を両方に適用すれば同等です。以下は完全な stateful ルールセットの例（ループバック許可 →
確立済み/関連トラフィック許可 → 必要な hub↔agent トラフィックの明示許可 → 残りを拒否、の順。
ハブのアドレスとポートは環境に合わせて置き換え）:

```bash
# --- nftables 推奨版（IPv4/IPv6 を単一ルールセットでカバー） ---
nft add table inet isolated
nft add chain inet isolated output '{ type filter hook output priority 0; policy drop; }'
nft add chain inet isolated input  '{ type filter hook input  priority 0; policy drop; }'

# ループバックは無条件許可
nft add rule inet isolated output oif lo accept
nft add rule inet isolated input  iif lo accept

# 確立済み/関連トラフィックを許可（hub からの inbound 応答が
# ハブの ephemeral port 宛に返ってくるため、これが無いと agent が
# ハブに到達不能になる）
nft add rule inet isolated output ct state established,related accept
nft add rule inet isolated input  ct state established,related accept

# 新規の outbound はハブの webhook/agent ポート宛のみ許可
nft add rule inet isolated output ip  daddr <hub-ipv4> tcp dport 3001 ct state new accept
nft add rule inet isolated output ip6 daddr <hub-ipv6> tcp dport 3001 ct state new accept

# 残りはすべて拒否（chain policy が drop のため明示ルール不要。
# ここまでに合致しなかったパケットは自動的に落ちる）
```

```bash
# --- iptables + ip6tables 版（nftables が使えない環境向け。
#     IPv4/IPv6 の両方に必ず同じルールを適用すること） ---
for CMD in iptables ip6tables; do
  # ループバックは無条件許可
  $CMD -A OUTPUT -o lo -j ACCEPT
  $CMD -A INPUT  -i lo -j ACCEPT
  # 確立済み/関連トラフィックを許可（hub からの inbound 応答に必須）
  $CMD -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  $CMD -A INPUT  -m state --state ESTABLISHED,RELATED -j ACCEPT
done
# 新規の outbound はハブの webhook/agent ポート宛のみ許可（IPv4/IPv6 それぞれ）
iptables  -A OUTPUT -d <hub-ipv4> -p tcp --dport 3001 -m state --state NEW -j ACCEPT
ip6tables -A OUTPUT -d <hub-ipv6> -p tcp --dport 3001 -m state --state NEW -j ACCEPT
# 残りは拒否
for CMD in iptables ip6tables; do
  $CMD -A OUTPUT -j REJECT
  $CMD -A INPUT  -j REJECT
done
```

### 将来計画

- ACL の機械検証（`tailnet_acl` check としての isolation doctor への追加）: **#85**
- 上記のアプリケーション化（設定 UI / 自動適用）: **#86**

現時点ではいずれも手動運用です。isolation doctor の9 check（3節）には tailnet ACL の検証は
含まれていません。

## 7. 隔離タスクの pushing は当面 operator 責務

隔離サーバーには push 資格情報（gh 認証、SSH 鍵、git credential helper）を一切配置しない
構成が前提のため、`PhaseLoopRunner` は `isolationIntent: true` のサーバー上で実行される
タスクについて、Unit の `phaseConfig` に `pushing` フェーズ（`pushVerify` フラグを持つフェーズ）
が含まれていても**自動的にスキップ**します。実行ログに `pushing_skipped_isolated` として
記録され、他の全フェーズが正常完了していれば testing 終端と同じ扱いでタスクは `review` へ
遷移します。コミット・プッシュ・PR 作成は operator が手動で行ってください。

ハブが隔離タスクに代わって push を代行する正式サポートは **#87** で計画中です（隔離サーバーへ
push 専用の限定資格情報を配布する設計を検討中）。それまでは、隔離サーバー上のタスクに
`pushing` フェーズを含む Unit を割り当てても安全側にスキップされますが、意図が明確になるよう
`pushing` を含まない Unit を割り当てることを推奨します。

また、browser-ops など operator 権限を要する機能（CDP ブラウザ経由の操作など）についても、
隔離サーバー上のタスクからの利用は現状のアーキテクチャ上想定されていません（operator 相当の
資格情報が必要なため、そもそも隔離サーバーには届きません）。

## 関連ドキュメント

- [セキュリティ設定・環境構築ガイド](./security-setup.md) -- 主体分離（operator/task）、scoped auth の有効化手順
- [タスク管理ガイド](./tasks.md) -- タスクの実行フロー、フェーズループ

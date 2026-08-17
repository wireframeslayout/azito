---
name: azt-summon
description: いまの会話の作業内容を Sidekick（スキルパッケージ）として azito のユーザー層に作成・編集する。既存 Sidekick への言及なら編集モード、新規なら作成モードに入り、ヒアリング後に SKILL.md を組み立てて POST/PUT /api/sidekicks で反映する。
allowed-tools: Bash, Read, AskUserQuestion
user_invocable: true
argument-hint: [何をスキル化/どう直すか (任意)]
---

<instructions>

# azt-summon — Sidekick を作成・編集する

> **オペレーター専用**（UI トークンが必要）。タスクペインで実行すると operator_required になる。

Sidekick は `SKILL.md`（frontmatter + テンプレート変数入り本文）と、任意の `scripts/`
（決定的な処理を委譲するシェルスクリプト）からなるスキルパッケージです。このスキルは、
いま会話中に行った作業やユーザーの依頼を Sidekick として切り出して**新規作成**するか、
既存 Sidekick の内容を会話文脈に沿って**編集**します。

## 引数

- 引数（任意）: 何をスキル化/どう直したいかの説明。省略時は直前の会話文脈から判断する。

## Step 1: 既存 Sidekick を確認し、作成/編集を判定する

```bash
curl -sf -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO_URL:-http://localhost:3001}/api/sidekicks"
```

一覧を見て、以下のいずれかに該当する場合は**編集モード**（Step 2E 以降）に入る:
- 引数やユーザーの発話が既存パッケージの `name` に一致する、または明確にそれを指している
- 「〜を直して」「〜の tags を変えて」「さっきの Sidekick に scripts を足して」など、
  既存 Sidekick への変更を意図する言い回しがある

該当しなければ**作成モード**（Step 2N 以降）に入る。判断がつかない場合はユーザーに確認する。
作成モードで name/description が既存と重複・類似する場合も、新規作成ではなく編集を勧める。

---

## 作成モード

### Step 2N: ヒアリング（会話文脈があれば最小化する）

**直前の会話でユーザーと一緒に具体的な作業（調査手順・実装パターン・レビュー観点など）を
行っていた場合、その内容をそのまま SKILL.md 本文の下書きとして使い、以下の4項目だけを
ユーザーに確認する（AskUserQuestion ツールが利用可能ならそれを使う）。** 会話文脈が無い、または引数だけでは何をする Sidekick か判断できない
場合のみ、実行手順の概要も含めて詳しくヒアリングする。

確認する4項目:
- **name**: kebab-case（`^[a-z0-9][a-z0-9-]*$`）。既存と重複しない一意な名前。**Robin / Falcon の
  ような固有のペルソナ名を推奨する**（`/azt-sidekick robin` のように覚えやすく呼び出せる。
  `xxx-default` のような機能名でも構わないが、複数のカスタム Sidekick を運用するならペルソナ名の
  方が区別しやすい）
- **description**: 1文でこの Sidekick が何をするものかを説明
- **tags**: カンマ区切りの自由語彙タグ（例: `implementing, reviewing`）。`planning` / `implementing` /
  `reviewing` / `testing` / `pushing` の5つは「phase タグ」として特別扱いされ、Unit の
  `phase_config` はそのタグを持つ Sidekick しか各フェーズに割り当てられない。特定タスクフェーズに
  紐づかない汎用スキル（イシュー作成など）は phase タグを持たせず、`issue` のような自由なタグだけ
  （または空）にする。1つの Sidekick に複数の phase タグを付けてもよい（例: 実装とレビューを兼ねる）
- **isDefault**: 持っている phase タグそれぞれのデフォルト Sidekick として採用するか（phase タグを
  1つも持たない場合は指定しても意味を持たない）。既存のデフォルトを上書きする（Unit が
  `phase_config` で明示的に差し替えていない限り、そのフェーズは全タスクでこの Sidekick が
  使われるようになる）ため、**明示的な意図がない限り false を既定にする**

続けて Step 3（本文作成）へ進む。

---

## 編集モード

### Step 2E: 現在の内容を取得する

```bash
curl -sf -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO_URL:-http://localhost:3001}/api/sidekicks/<name>"
```

`description` / `tags` / `isDefault` / `body`（および `layer`: builtin か user か）を取得する。

**ビルトイン（`layer: "builtin"`）を編集する場合の注意**: 更新は copy-on-write で
ユーザー層にパッケージ一式（`scripts/` 含む）がコピーされ、以後そのビルトインの更新
（harness 同期）の影響を受けなくなる。ユーザーにその旨を伝える。元に戻したい場合は
`DELETE /api/sidekicks/<name>` または UI の「Revert to built-in」でビルトイン版に戻せる。

会話文脈・ユーザーの要望から、変更したい項目（description / tags / isDefault / body の
一部 / scripts の追加・更新）を特定する。不明瞭ならユーザーに確認する
（新規作成時の4項目ヒアリングを流用してよいが、変更しない項目は既存値のまま据え置く）。

body を書き換える場合は Step 3 の規約に従う。据え置く項目は PUT リクエストに含めない
（未指定フィールドは既存値が保持される）。

続けて Step 4（確認提示）へ進む（Step 3 はテンプレート変数規約の参照として必要な場合のみ通過）。

---

## Step 3: SKILL.md 本文を作成する（作成モード / 編集モードで body を書き換える場合）

本文には以下の規約に従ってテンプレート変数・スクリプト委譲を組み込む:

- `{{task.*}}` / `{{project.*}}`: タスク実行文脈の変数。`task_id` 指定でのレンダリング時のみ
  展開される（それ以外は未展開のまま残るので、standalone パッケージも安全に render できる）
- `{{sidekick.dir}}`: このパッケージのディレクトリの絶対パス（タスクの実行サーバー基準。
  ssh/agent 実行時は同期先パスに解決される）
- **決定的な処理（git 操作・ファイル操作など再現性が必要な手順）は本文に書き下すのではなく
  `scripts/` 配下のシェルスクリプトへ切り出し**、本文からは
  `{{sidekick.dir}}/scripts/xxx.sh` を実行させる。パラメータは本文のプレースホルダをスクリプトへ
  文字列展開するのではなく、実行時に環境変数として渡す規約とする（インジェクション防止のため）
- **本文に完了マーカーやシグナル規約（`PHASE_COMPLETE` / `QUESTIONS_JSON` / `TEST_FAILED` 等）を
  書かない。** これは本文（能力）ではなく実行プロトコルであり、実行文脈（state-machine /
  skill）が「封筒」として自動的に付加する（Issue #263 Refine D）。本文には完了時の振る舞いや
  出力内容だけを書き、マーカー文言・echo コマンドは書かない

本文の分量は既存ビルトイン Sidekick（`harness/sidekicks/*/SKILL.md`）を参考に、
簡潔だが実行可能な具体性を持たせる。

## Step 4: 確認提示

- **作成モード**: 作成予定の name / description / tags / isDefault / 本文（+ scripts があれば
  その一覧）をユーザーに提示し、確認を得る。
- **編集モード**: 変更する項目のみを diff 形式（変更前 → 変更後）で提示する（据え置く項目は
  再掲しない）。ビルトインを編集する場合は copy-on-write の注意を改めて添える。

修正依頼があれば反映して再提示する。

## Step 5: 反映する

body は複数行の Markdown なので、**JSON 文字列へシェル置換で直接埋め込まない**
（改行・引用符のエスケープ事故になる）。本文を一時ファイルに書き出し、`jq --rawfile` で
JSON を組み立てて `curl -d @-` に渡す。

### 作成モード: POST /api/sidekicks

```bash
cat > /tmp/azt-summon-body.md <<'BODY_EOF'
<SKILL.md本文をここに>
BODY_EOF

jq -n \
  --arg name "<name>" \
  --arg description "<description>" \
  --arg tags "<tag1, tag2>" \
  --argjson isDefault false \
  --rawfile body /tmp/azt-summon-body.md \
  '{name: $name, description: $description,
    tags: ($tags | split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(length > 0))),
    isDefault: $isDefault, body: $body}' \
| curl -sf -X POST -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO_URL:-http://localhost:3001}/api/sidekicks" \
    -H "Content-Type: application/json" -d @-
```

タグが無い（phase タグを持たない汎用スキル）場合は `--arg tags ""` を渡す（空文字は空配列になる）。

`scripts` を含める場合も同様に、各スクリプトを一時ファイルへ書き出して `--rawfile` で読み込み、
`scripts` 配列に組み込む（`content` へシェル置換で直接埋め込まない）:

```bash
cat > /tmp/azt-summon-script.sh <<'SCRIPT_EOF'
<script content>
SCRIPT_EOF

jq -n \
  --arg name "<name>" \
  --arg description "<description>" \
  --arg tags "<tag1, tag2>" \
  --argjson isDefault false \
  --rawfile body /tmp/azt-summon-body.md \
  --rawfile script /tmp/azt-summon-script.sh \
  '{name: $name, description: $description,
    tags: ($tags | split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(length > 0))),
    isDefault: $isDefault, body: $body,
    scripts: [{filename: "xxx.sh", content: $script}]}' \
| curl -sf -X POST -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO_URL:-http://localhost:3001}/api/sidekicks" \
    -H "Content-Type: application/json" -d @-
```

`scripts` が無ければキー自体を渡さない。

- 失敗時（400: name 重複・tags の形式不正・isDefault: true なのに phase タグが無い、など）:
  レスポンスの `error` をそのままユーザーに提示し、必要なら name/tags/isDefault を修正してやり直す
- 成功時（201）: `{"ok": true, "name": "<name>"}` が返る

### 編集モード: PUT /api/sidekicks/\<name\>

**変更する項目だけを JSON に含める**（未指定フィールドは既存値のまま保持される）。
body を書き換える場合のみ `--rawfile body`、scripts を追加/更新する場合のみ `scripts` を含める
（scripts は upsert のみ。同名ファイルは上書き、既存の他ファイルは削除されない）:

```bash
# 例: description と tags だけを変更する場合
jq -n \
  --arg description "<new-description>" \
  --arg tags "<new-tag1, new-tag2>" \
  '{description: $description,
    tags: ($tags | split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(length > 0)))}' \
| curl -sf -X PUT -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO_URL:-http://localhost:3001}/api/sidekicks/<name>" \
    -H "Content-Type: application/json" -d @-
```

```bash
# 例: body と scripts を書き換える場合
cat > /tmp/azt-summon-body.md <<'BODY_EOF'
<修正後の SKILL.md本文をここに>
BODY_EOF
cat > /tmp/azt-summon-script.sh <<'SCRIPT_EOF'
<修正後の script content>
SCRIPT_EOF

jq -n \
  --rawfile body /tmp/azt-summon-body.md \
  --rawfile script /tmp/azt-summon-script.sh \
  '{body: $body, scripts: [{filename: "xxx.sh", content: $script}]}' \
| curl -sf -X PUT -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO_URL:-http://localhost:3001}/api/sidekicks/<name>" \
    -H "Content-Type: application/json" -d @-
```

- 失敗時（404: 存在しない name / 400: tags の形式不正・isDefault: true なのに phase タグが無い・
  scripts のファイル名不正など）: レスポンスの `error` をそのままユーザーに提示し、必要なら入力を
  修正してやり直す
- 成功時（200）: `{"ok": true}` が返る

一時ファイルを使った場合は反映後に削除する（`/tmp/azt-summon-*`）。

## Step 6: 結果を報告する

- **作成モード**: Sidekick `"<name>"` をユーザー層に作成したこと、`/azt-sidekick <name>` で
  実行できること、`isDefault: true` で登録した場合は対象フェーズの全タスクでこの Sidekick が
  使われるようになることを報告する。
- **編集モード**: Sidekick `"<name>"` のどの項目を変更したかを報告する。ビルトインを編集した
  場合は、ユーザー層にコピーされ以後ビルトイン更新の影響を受けなくなったこと、
  `DELETE /api/sidekicks/<name>`（または UI の「Revert to built-in」）で元に戻せることを添える。

</instructions>

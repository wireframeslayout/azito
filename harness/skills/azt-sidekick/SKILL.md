---
name: azt-sidekick
description: 指定した Sidekick（スキルパッケージ）を実行する。名前を1つ以上引数に取り、azito からレンダリング済み本文を取得してその指示に順次従う。最後の引数が数値なら task_id として扱われる。
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
user_invocable: true
argument-hint: [sidekick_name...] [task_id]
---

<instructions>

# azt-sidekick — Sidekick（スキルパッケージ）を実行する

Sidekick は `harness/sidekicks/` （ビルトイン）またはユーザー層に置かれたスキルパッケージ
（`SKILL.md` + 任意の `scripts/`）です。`/azt-plan` 等のフェーズ固有スキルとは異なり、
任意の Sidekick を名前指定でその場で実行するための汎用スキルです。

Sidekick には Robin / Falcon のような固有のペルソナ名を付ける運用を推奨します（`name` フィールドが
そのまま呼び出し名になるため、`/azt-sidekick robin` のように呼べます）。

## 引数

複数の Sidekick 名を指定でき、その順序で1つずつ実行します。

- `$1 ... $N`（`N` は最後の引数が数値かどうかで決まる）: Sidekick 名を1つ以上、スペース区切りで指定（例:
  `planning-default`, `issue-default`, `robin`, `falcon` のようなユーザー作成のカスタム Sidekick 名）。省略可。
- 最後の引数が数値の場合、それは task_id として扱われる（Sidekick 名の一部ではない）。指定すると
  `{{task.*}}` / `{{project.*}}` テンプレート変数がそのタスクの文脈で展開される。省略時は
  `{{sidekick.*}}` のみ展開され、task/project 系変数は未展開のまま残る（phase タグ無しの汎用スキルも
  安全に実行できる）。task_id は全ての Sidekick 実行で共通して使われる
- 環境変数 `AZITO_URL`: AZITOのベースURL（未設定時は `http://localhost:3001`）

引数の区切りはスペース。例:
- `/azt-sidekick pushing-default` — pushing-default を1つだけ実行
- `/azt-sidekick pushing-default 42` — task_id=42 の文脈で pushing-default を実行
- `/azt-sidekick robin falcon 42` — task_id=42 の文脈で robin → falcon の順に実行

## Step 1: 引数を解析する

引数が空なら Step 2 へ進み、一覧提示のみ行って終了する（ユーザーの選択を待つ）。
引数がある場合、**最後の引数が数値かどうか**を判定する:
- 数値である場合: それを `TASK_ID` とし、残りの引数を実行対象の Sidekick 名リスト（順序維持）とする
- 数値でない場合: `TASK_ID` は環境変数 `AZITO_TASK_ID`（task ペインに既に注入されている自タスクのID。
  `TASK_ID="${LAST_ARG:-$AZITO_TASK_ID}"` の形で、明示引数を優先しつつ既定値として使う）、
  全引数を Sidekick 名リストとする

`AZITO_TASK_ID` も未設定（operator のペイン等）の場合は `TASK_ID` は空のままでよい
（task/project 系テンプレート変数は未展開のまま残る、従来どおりの standalone 実行）。

Sidekick 名リストが得られたら Step 3 へ進む。

## Step 2 (name 未指定時): 一覧を表示して選択を促す

```bash
curl -sf -H "Authorization: Bearer ${AZITO_TASK_TOKEN:-$AZITO_UI_TOKEN}" "${AZITO_URL:-http://localhost:3001}/api/sidekicks"
```

取得した配列の各要素から `name` / `description` / `tags` / `isDefault` を抽出して表で提示し
（`tags` が空配列の Sidekick は「汎用（phase タグ無し）」と注記する）、
「どの Sidekick を実行しますか？（`/azt-sidekick <name> [<name2> ...]` で再度呼び出してください）」と
ユーザーに尋ねる。

## Step 3: Sidekick 名リストを順に実行する

Sidekick 名リストの各 `NAME` について、以下の Step 3a〜3d を順番に（前の Sidekick の完了報告を終えてから
次へ進む形で）実行する。

### Step 3a: 本文を取得する

```bash
if [ -n "$TASK_ID" ]; then
  curl -sf -H "Authorization: Bearer ${AZITO_TASK_TOKEN:-$AZITO_UI_TOKEN}" "${AZITO_URL:-http://localhost:3001}/api/sidekicks/${NAME}?render=1&task_id=${TASK_ID}"
else
  curl -sf -H "Authorization: Bearer ${AZITO_TASK_TOKEN:-$AZITO_UI_TOKEN}" "${AZITO_URL:-http://localhost:3001}/api/sidekicks/${NAME}?render=1"
fi
```

- HTTP 404: 「Sidekick "`<NAME>`" が見つかりません。`/azt-sidekick`（引数なし）で一覧を確認してください」と
  ユーザーに伝える。この Sidekick はスキップし、リストの残りがあれば続行する（実行を試みたり別名で代用したりしない）
- HTTP 400/500 等その他のエラー: エラーレスポンスの内容（`error` フィールド）をそのままユーザーに提示する。
  この Sidekick はスキップし、リストの残りがあれば続行する
- 成功時: レスポンス JSON の `prompt` フィールドがこの Sidekick の実行指示内容、`tags` フィールドがその
  タグ一覧（phase タグ判定は `tags` に planning/implementing/reviewing/testing/pushing のいずれかが
  含まれるかで行う）

### Step 3b: 取得した指示に従って実行する

`prompt` の内容を、ユーザーから与えられた実行指示として扱い、そのまま実行する。
本文中に `{{sidekick.dir}}/scripts/xxx.sh` への言及があれば、そのスクリプトを実行する
（本文はテンプレート展開済みだが scripts/ の中身自体は展開されないため、指示に従い環境変数でパラメータを渡す）。

### Step 3c: 質問への対応

質問がある場合はユーザーに直接質問する（AskUserQuestion ツールが利用可能ならそれを使う）。

### Step 3d: この Sidekick の完了報告

`<NAME>` の実行結果の概要を報告してから、リストに次の Sidekick があれば Step 3a に戻る。

## Step 4: 全体の完了報告

リスト全体の実行が終わったら、実行した Sidekick 名（順序どおり）とそれぞれの結果概要をまとめて
ユーザーに報告する。`nextPhase` 相当の案内は phase タグを持たない Sidekick（issue-default 等）には
無いため、フェーズ連結が必要な場合は `/azt-plan` 〜 `/azt-push` 側のフローに従う。

</instructions>

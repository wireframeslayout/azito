# Sidekick / Unit / Operation ガイド

> **概念モデル（Issue #263 再設計 最終形）**: 旧「Sidekick」は「実行環境を定義する単位（オーケストレーター＋ワーカー＋tmuxセッション紐づけ）」でしたが、この再設計で以下のように整理されました。
>
> - **Sidekick** -- **タグ付きスキルパッケージ**（`SKILL.md` + `scripts/`）。`tags: string[]` を持ち、
>   `planning`/`implementing`/`reviewing`/`testing`/`pushing` の5つは特別扱いの **phase タグ**として扱われる。
>   phase タグを持つ Sidekick はそのフェーズの割当候補になり、`isDefault` はその phase タグそれぞれの
>   既定候補であることを示す。phase タグを持たない Sidekick は汎用スキル（イシュー作成など）
> - **Unit** -- **オペレーションを実行するチーム**。ワークフロー定義（フェーズごとの Sidekick 割当・
>   有効/無効、システムプロンプト、self-review・サブエージェント設定）と、実行ランタイム（ワーカー種別・
>   モデル・追加引数・UnitType）の両方を1つのエンティティとして持つ
>   （Refine A/B で分離した Operation と WorkerProfile を Refine B で再統合したもの）
> - **Operation** -- Unit が**タスクを遂行する1回の実行ラン**。DB に永続化される設定エンティティでは
>   なく、`GET /api/operations` が返す「現在実行中の Unit×Task の組」がその実体
> - 「どこで実行するか」は `project_servers`（プロジェクトとサーバーの紐づけ）と `tasks.server_name`（タスク単位の上書き）が担う
>
> 本ページはこの最終形のガイドです。旧ドキュメント（phase 単一値・Operation=ワークフロー定義・WorkerProfile 別体）を参照していた場合は本ページの内容に読み替えてください。

## 全体像

タスクを実行する際、以下の3つの要素が組み合わさります。

```
Task
 ├─ Unit（オペレーションを実行するチーム）
 │   ├─ phaseConfig ─→ 各フェーズで使う Sidekick（tags で絞り込まれた候補から選択）
 │   └─ 実行ランタイム（workerType / workerModel / workerExtraArgs）
 └─ serverName / project_servers（どこで実行するか）
```

- **Sidekick** はフェーズの「やり方」（プロンプト＋決定的スクリプト）。`tags` でどのフェーズに使えるかが決まる
- **Unit** はワークフロー全体の「設定」（Sidekick 割当・振る舞い）と「実行手段」（ワーカー・オーケストレーター）を両方持つチーム
- **Operation** は Unit がタスクを実行している最中の1回のラン（実行中一覧として観測できる）
- 実行場所はプロジェクトとサーバーの組（`project_servers`）、またはタスクごとの `server_name` 上書きで決まる

## Sidekick（タグ付きスキルパッケージ）

### 構造

Sidekick は Claude Code の Skill と同じ形式のディレクトリです。

```
<name>/
  SKILL.md        必須。YAML風 frontmatter + Markdown 本文
  scripts/        任意。決定的な処理（git操作・ファイル操作など）を委譲するシェルスクリプト
  references/     任意。参考資料
```

`SKILL.md` の frontmatter:

```yaml
---
name: robin                          # kebab-case（^[a-z0-9][a-z0-9-]*$）。固有のペルソナ名を推奨
description: 何をするスキルか（1文）
tags: implementing, reviewing        # 自由語彙タグ。カンマ区切り。複数の phase タグを持ってもよい
isDefault: false                     # 持っている phase タグそれぞれの既定 Sidekick として採用するか
---
本文（テンプレート変数入り Markdown）
```

`tags` は自由語彙のタグ配列です。`planning` / `implementing` / `reviewing` / `testing` / `pushing` の
5つは **phase タグ**として特別扱いされ、Unit の `phaseConfig` はそのタグを持つ Sidekick しか各フェーズに
割り当てられません。phase タグを1つも持たない Sidekick は汎用スキル（例: イシュー作成）で、
`/azt-sidekick` のようなスキルから直接名前指定で実行されます。1つの Sidekick が複数の phase タグを
持つことも可能です（例: 実装とレビューを兼ねるパッケージ）。

### ペルソナ名の運用

カスタム Sidekick には Robin / Falcon のような固有のペルソナ名を付けることを推奨します。`name`
フィールドがそのまま呼び出し名になるため、`/azt-sidekick robin` のように覚えやすく呼び出せます。
`xxx-default` のような機能名でも構いませんが、複数のカスタム Sidekick を運用する場合はペルソナ名の
方が区別しやすくなります。

### 2層構造（ビルトイン / ユーザー層）

- **ビルトイン層**: `harness/sidekicks/*` に同梱される標準パッケージ
- **ユーザー層**: ユーザーが作成・編集したパッケージ（`<repo-root>/data/sidekicks/`。環境変数 `AZITO_SIDEKICKS_DIR` で上書き可、起動時に一度だけ解決される）
- 同名パッケージが両層に存在する場合は**ユーザー層が優先**される（`overridesBuiltin: true`）
- ビルトインを編集すると **copy-on-write** が働く: パッケージ一式（`scripts/`・`references/` 含む）が
  ユーザー層にまるごとコピーされてから変更が書き込まれる。以後そのパッケージはユーザー層のものとして
  扱われ、ビルトインの更新（harness アップデート）の影響を受けなくなる
- ユーザー層のみ削除可能。ビルトインとの差分を取り消して「ビルトインに戻す」には、ユーザー層の
  コピーを削除する（`DELETE /api/sidekicks/:name`、または UI の「Revert to built-in」）

### ビルトイン7種

| name | tags | 内容 |
|---|---|---|
| `planning-default` | planning | タスクを分析し実装計画を作成する |
| `implementing-default` | implementing | 計画に従って実装する |
| `reviewing-default` | reviewing | 自身の実装をレビューし問題を修正する |
| `testing-default` | testing | 実装したコードのテストを実行する |
| `pushing-default` | pushing | commit/push/PR作成をスクリプト実行（`scripts/push.sh`）で行う |
| `issue-default` | issue | イシューを作成する（`/azt-issue` が薄いラッパーとして利用） |
| `browser-ops` | browser | ブラウザ操作（CDP 接続ヘルパーとログイン・ログ衛生規約）を提供する |

### テンプレート変数

`SKILL.md` 本文には以下のテンプレート変数を埋め込める（`{{...}}` 記法）。展開は
`renderSidekickBody` / `expandPromptTemplate` が行う。

| 変数 | 内容 |
|---|---|
| `{{task.title}}` / `{{task.description}}` / `{{task.plan}}` / `{{task.targetBranch}}` | タスクの基本情報 |
| `{{task.pushTaskDescription}}` / `{{task.pushRules}}` / `{{task.pushOutput}}` | pushing フェーズ向けの構築済みテンプレート変数（`skipPr` の有無で内容が変わる） |
| `{{project.sidekickPrompt}}` / `{{project.defaultBranch}}` | プロジェクト単位の追加指示・既定ブランチ |
| `{{projectServer.workingDirectory}}` / `{{projectServer.branch}}` | 実行サーバー上の作業ディレクトリ・ブランチ |
| `{{selfReview.attempt}}` / `{{selfReview.maxAttempts}}` | self-review の試行回数 |
| `{{module.reviewPerspectives}}` / `{{module.softwareDesignPrinciples}}` / `{{module.uiDesignPrinciples}}` | `harness/prompt-modules/` のルールファイル本文 |
| `{{sidekick.dir}}` | このパッケージのディレクトリの絶対パス（**実行サーバー基準**。ssh/agent サーバーではリモート同期先のパスに解決される） |
| `{{sidekick.name}}` | パッケージ名 |

`task_id` を指定せずに render する場合（汎用スキルのプレビューなど）は、
`task.*` / `project.*` / `projectServer.*` / `selfReview.*` は未展開のまま残される
（`{{sidekick.*}}` / `{{module.*}}` のみ展開）。

### scripts/ への委譲規約

決定的な処理（git 操作・ファイル操作など再現性が必要な手順）は本文に書き下さず、
`scripts/` 配下のシェルスクリプトへ切り出す。本文からは
`{{sidekick.dir}}/scripts/xxx.sh` の形で実行を指示する。

**重要**: `scripts/` 配下のファイルの中身にはテンプレート展開を適用しない
（インジェクション防止）。本文の値をスクリプトへ渡す場合は、実行時に**環境変数として渡す**規約とする。
タスクの `title`/`description` のような外部入力をテンプレート展開でスクリプトへ文字列注入すると、
コマンドインジェクションの経路になるため禁止されている。

### リモートサーバーへの同期

タスクが ssh/agent サーバーで実行される場合、Sidekick パッケージは実行前にそのサーバーへ同期される
（`SidekickSyncService`、配置先は `~/.azito/sidekicks/<name>/`）。同期はハッシュベースで差分がある
場合のみ転送し、複数タスクが同時に実行されてもロック（`~/.azito/sidekicks.lock`）で競合を防ぐ。

### 実行プロトコルの封筒化（execution envelope）

`SKILL.md` 本文は**能力**（何をするか）だけを書く。完了・質問・テスト失敗をどう合図するかという
**実行プロトコル**は本文に書かず、実行文脈（`executionEnvelope.ts`）が本文の外側に「封筒」として
付加する（Issue #263 Refine D）。

- **state-machine**（`PhaseLoopRunner`、`workerExecutionMode: 'tmux-pipe'` の場合）:
  `AZITO_DONE_*` / `AZITO_QUESTIONS_*` / `AZITO_TEST_FAILED_*` マーカーと `AZITO_PHASE_SUMMARY` 行を
  含む `<completion_signal>` ブロックを本文の末尾に付加する。質問セクション・テスト失敗セクションは
  UnitTypePhase 定義の `questions` / `testFailed` フラグに基づいて条件付きで含まれる
- **http-signal**（`PhaseLoopRunner`、`workerExecutionMode: 'http-signal'` の場合）:
  `azitoctl` CLI を通じて完了・質問・テスト失敗を報告する封筒を付加する。シグナルファイルへの
  マーカー書き込みの代わりに `azitoctl complete` / `azitoctl questions` コマンドで通知する方式
- **skill**（`/azt-plan` 等の harness スキル、`RenderSkillPromptUseCase` 経由）: 自然言語で
  「完了したら報告」「不明点はユーザーに直接質問」等を付加する。同じ UnitTypePhase フラグで判定する
- **standalone**（`GET /api/sidekicks/:name?render=1`、`/azt-sidekick` の直接実行）: 封筒は一切
  適用されない。本文がそのまま返る

このため `SKILL.md` 本文に `PHASE_COMPLETE` / `QUESTIONS_JSON` / `TEST_FAILED` のようなマーカー文言や
echo コマンドを書いてはいけない（`/azt-summon` の作成規約にも明記）。

### API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/sidekicks` | 一覧（メタ情報のみ、body を含まない。`tags`/`isDefault` を含む） |
| GET | `/api/sidekicks/:name` | 詳細（body を含む）。`?render=1` でテンプレート変数展開（`task_id` 任意） |
| POST | `/api/sidekicks` | ユーザー層に新規作成（name/description 必須、tags/body/scripts/isDefault 任意） |
| PUT | `/api/sidekicks/:name` | 更新（description/tags/isDefault/body/scripts）。ビルトインは copy-on-write |
| DELETE | `/api/sidekicks/:name` | ユーザー層のみ削除可（ビルトインへの revert、またはユーザー専用パッケージの削除） |

## Unit（オペレーションを実行するチーム）

Unit は「タスクをどう進めるか」（振る舞い）と「何で進めるか」（実行ランタイム）を両方持つチームです。
旧「Sidekick」が担っていた実行環境の定義（tmuxセッション・ワーカー種別など）のうち「どこで動くか」は
`project_servers` / `task.serverName` に残りますが、「何のワーカーで、どう駆動するか」は Unit 自身が
持ちます（Refine A/B で一時分離した Operation・WorkerProfile を Refine B で1つの Unit へ再統合）。

### 持つ設定

| 項目 | 説明 |
|---|---|
| Name | Unit 名 |
| UnitType | フェーズ構成を定義する UnitType 名（`devops` 等、`harness/unit-types/*.toml` で定義） |
| Worker Type / Worker Model / Worker Extra Args | 実行ランタイム。`claude` / `codex` / `generic` とそのモデル・追加 CLI 引数 |
| Worker Execution Mode | ワーカー出力の監視方式（`tmux-pipe` / `http-signal`） |
| Worker Runtime | ワーカーランタイム（`tui`） |
| System Prompt | ワーカーが各フェーズで参照するベースプロンプト（省略可） |
| Self-Review Max Attempts | self-review（reviewing フェーズでの差し戻し）の既定最大試行回数。タスク単位で上書き可 |
| Review Subagent / Implement Subagent | レビュー・実装作業をサブエージェントへ委譲する設定（provider/model）。タスク単位で上書き可 |
| Phase Config | フェーズごとの Sidekick 割当・有効/無効 |

フェーズ順序は Unit の `unitType` が参照する UnitType 定義（TOML）で決まる。デフォルトの `devops`
タイプでは planning → implementing → reviewing → testing → pushing の順に `phaseConfig` に従って
遷移する

### phase_config によるフェーズ設定

`phaseConfig` は UnitType で定義された各フェーズに対し、
以下を指定できる:

```jsonc
{
  "implementing": { "sidekick": "robin" }, // このフェーズだけ既定と違う Sidekick を使う
  "testing": { "enabled": false }          // このフェーズをスキップする
}
```

- `sidekick` 省略時はそのフェーズの既定パッケージ（そのフェーズの phase タグを持ち `isDefault: true` のもの）が使われる
- 指定した Sidekick がそのフェーズの phase タグを持たない場合はエラー（設定ミスとして fail fast、
  黙ってフォールバックしない）
- `enabled: false` のフェーズは実行順序から除外され、直前の有効フェーズから次の有効フェーズへ直接遷移する

解決ロジックは `resolvePhaseSidekick.ts` に一元化されており、ステートマシン実行ループ
（`PhaseLoopRunner`）と `/azt-*` スキル向けのプロンプト解決（`RenderSkillPromptUseCase`）の
どちらからも同じ関数を通る。

### プロジェクトデフォルト + タスク上書き

- `project.defaultUnitId`: プロジェクトの既定 Unit。タスク作成フォームでは自動的に事前選択され、
  「プロジェクトのデフォルト」である旨が表示される
- `task.unitId`: タスク単位の上書き（`null` の場合はプロジェクトの既定にフォールバック）。
  Unit もプロジェクトデフォルトも無い場合、そのタスクは実行時にエラーになる（UI は事前に警告を表示する）
- 同様に `task.serverName`（実行サーバー上書き）、`task.selfReviewMaxAttempts` /
  `task.reviewSubagent` / `task.implementSubagent`（Unit の既定値をタスク単位で上書き）も存在する

### 旧概念からの移行対応表

| 旧項目 | 最終形での置き場所 |
|---|---|
| 旧 Sidekick の Worker Command / Worker Model / Worker Extra Args | Unit（実行ランタイム） |
| 旧 Sidekick の Orchestrator Provider / Orchestrator Mode | 廃止（orchestratorMode は UnitType 駆動のフェーズループに置き換え） |
| 旧 Sidekick の Server / tmux Session | `project_servers`（プロジェクト×サーバーの紐づけ）、タスク単位では `task.serverName` |
| 旧 Sidekick の Max Concurrency | 廃止（並列実行数の制御は概念自体を持たなくなった） |
| Operation（ワークフロー定義）の System Prompt / Self Review Max Attempts / Subagent Delegation / Phase Config | Unit にそのまま統合 |
| WorkerProfile（実行ランタイム）一式 | Unit に統合。`project.defaultWorkerProfileId` → `project.defaultUnitId` |
| Sidekick の `phase: <value>`（単一値） | Sidekick の `tags: string[]`（複数可、phase タグ + 自由タグ） |
| Operation（旧: DB エンティティとしてのワークフロー定義） | Unit に名称・実体ともに統合。「Operation」という語は「Unit の実行ラン」の意味に転用 |

## Operation（Unit の実行ラン）

Operation という語は最終形では「ある Unit がタスクを遂行している最中の**1回の実行ラン**」を指します。
DB に永続化される設定エンティティではなく、`GET /api/operations` が返す「現在実行中の (unitId, taskId,
target) の組」の一覧としてのみ観測できます。ワークフロー定義そのものは Unit 側にあります。

## 実行場所（project_servers / task.serverName）

- `project_servers` テーブルがプロジェクトとサーバーの紐づけを持つ（`working_directory` /
  `branch` / `tmux_session` を含む）。1プロジェクトに複数サーバーを紐づけ可能
- タスクは既定でプロジェクトの最初の `project_servers` 行のサーバーを使うが、
  `task.serverName` で個別に上書きできる
- タスク単位の `workingDirectory` 上書きも可能（プロジェクトサーバーの既定ディレクトリより優先）

## UI

| 画面 | 内容 |
|---|---|
| **Sidekicks**（スキルライブラリ） | phase タグごとにグルーピングされた Sidekick 一覧（複数 phase タグを持つ場合は各グループに重複表示）。タグクリックで絞り込み。`Built-in` / `Custom`、`Default`、`Overridden`、`Scripts` をバッジで表示。クリックで詳細（SKILL.md 本文編集、タグはチップ入力） |
| **Units** | Unit 一覧。ランタイム要約（Worker Type/Model チップ）、自己レビュー回数、無効化フェーズ、カスタム Sidekick 割当をバッジで表示。クリックで詳細（設定・割当タスク・ログ）を開き、「Edit Unit」から編集画面へ。編集画面は Name → Runtime → Phases → Subagents → Advanced（System Prompt・Self-Review）の順に構成 |
| **Operations** | 現在実行中の Operation（Unit×Task の組）一覧。Unit 名・タスク名・実行対象（target）を表示し、クリックでタスク詳細を開く |

## /azt-summon・/azt-sidekick の使い方

- `/azt-sidekick <name...> [task_id]`: 任意の Sidekick を1つ以上、名前指定でその場で順に実行する。
  名前を省略すると一覧を表示する
- `/azt-summon`: いまの会話の作業内容を Sidekick としてユーザー層に**作成・編集**する。既存の
  Sidekick への言及（name 一致・「〜を直して」等）であれば編集モードに入り、
  `GET /api/sidekicks/:name` で現在の内容を取得したうえで `PUT /api/sidekicks/:name` を呼ぶ。
  新規作成なら `POST /api/sidekicks` を呼ぶ。ペルソナ名（robin/falcon 等）を推奨する。詳細は
  `harness/skills/azt-summon/SKILL.md` を参照

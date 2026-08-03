# AZITO Harness

AZITO の Sidekick Mode を Claude Code スキル（`/azt-*`）として実行するためのハーネスです。

## azt-* スキルとは

`/azt-plan`, `/azt-implement`, `/azt-review`, `/azt-test`, `/azt-push` は、AZITO のタスク実行フェーズを Claude Code のスキルとして呼び出せるようにしたものです。

各スキルは AZITO の API からフェーズ固有のプロンプトを取得し、それに従って作業を実行します。state-machine 由来のマーカー（AZITO_DONE, QUESTIONS_JSON など）は使用せず、Claude Code がユーザーと自然な対話で進めます。

フェーズのプロンプトは、タスクが属する **Unit**（フェーズ→Sidekick マッピングと実行ランタイムを持つワークフロー定義）の `phase_config` が指す **Sidekick パッケージ**（`harness/sidekicks/` 配下、`SKILL.md` + 任意の `scripts/`）から解決されます。Unit 側で `phase_config` を差し替えれば、フェーズごとに実行される Sidekick をビルトインからカスタムへ変更できます。

## ビルトイン Sidekick

Sidekick は `tags: string[]` を持つタグ付きスキルパッケージです。planning/implementing/reviewing/testing/pushing の5つは
**phase タグ**として扱われ、Unit の `phase_config` で該当フェーズに割り当てられる候補になります。phase タグを持たない
Sidekick は汎用スキル（イシュー作成など）です。

| Sidekick | tags | 役割 |
|---|---|---|
| `planning-default` | planning | 計画立案 |
| `implementing-default` | implementing | 実装 |
| `reviewing-default` | reviewing | レビュー |
| `testing-default` | testing | テスト |
| `pushing-default` | pushing | commit/push/PR作成（`scripts/push.sh` に処理を委譲） |
| `issue-default` | (なし) | イシュー作成（`/azt-issue` が薄いラッパーとして利用） |

`GET /api/sidekicks` で一覧、`GET /api/sidekicks/:name?render=1` で個別の内容（テンプレート変数展開済み）を取得できる。

## azt-sidekick / azt-summon

- `/azt-sidekick <name> [task_id]`: 任意の Sidekick を名前指定でその場で実行する。名前を省略すると一覧を表示する。
- `/azt-summon`: いまの会話の作業内容を Sidekick としてユーザー層に作成・編集する。新規作成は `POST /api/sidekicks`、既存 Sidekick の更新（ビルトインは copy-on-write）は `PUT /api/sidekicks/:name` を使う。作成後は `/azt-sidekick <name>` で実行できる。

## azt-mission

- `/azt-mission [--parallel] [--base <branch>] <taskId | #issue>...`: 複数の azito タスク/GitHub Issue を「ミッション」として直列（または並列）に自動実行する。ミッション専用の統合ブランチを作成し、各タスクの実行監視（計画承認・質問回答・異常復旧）→PRレビュー・統合ブランチへのマージを繰り返し、最後に統合ブランチ→base の PR を1本作成する（最終マージはユーザー判断）。

## AZITO_URL の設定

スキルを使用する前に、環境変数 `AZITO_URL` に AZITO サーバーのベース URL を設定してください。

```bash
export AZITO_URL=http://localhost:3001
```

## 使い方

```
/azt-plan <task_id>
```

各フェーズ完了後、次のフェーズスキルが案内されます。

## セットアップ

`harness/setup.sh` を実行すると、`harness/skills/azt-*`（本スキルを含む）を `~/.claude/skills/` へシンボリックリンクし、azt-mcp（MCP サーバー）と Stop hook を `~/.claude/settings.json` へ登録する。

## Codex CLI 対応

`setup.sh` は Codex CLI（`codex` コマンドが PATH にあるか `~/.codex/` が存在する場合）にも以下を自動配置します:

| 配置先 | 内容 |
|--------|------|
| `~/.codex/skills/azt-*` | Claude Code と同一のシンボリックリンク（Codex は SKILL.md の `name`/`description` のみ読む） |
| `codex mcp add azt-mcp` | azt-mcp MCP サーバー（`AZITO_URL` を env として渡す） |
| `~/.codex/AGENTS.md` | `prompt-modules/*.md` の内容をマーカーブロックとして埋め込み（マーカー外のユーザー記述は保持） |

Codex CLI が検出されない環境では Codex セクション全体がスキップされ、Claude Code 向け処理のみが実行されます。

### マーカーブロック

`~/.codex/AGENTS.md` 内のハーネス管理領域は以下のマーカーで囲まれます:

```
<!-- AZITO-HARNESS:BEGIN (managed by harness/setup.sh) -->
...（prompt-modules の内容）...
<!-- AZITO-HARNESS:END -->
```

マーカー外に書いた内容はセットアップ再実行時も保持されます。

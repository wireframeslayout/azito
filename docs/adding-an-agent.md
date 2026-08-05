# 新しいエージェントの追加方法

AZITO はエージェント種別(claude / codex / generic など)を
`packages/server/src/modules/agents/` 配下の `IAgentProvider` レジストリで一元管理している。
新しいエージェントを追加する手順は次の1ディレクトリ + 登録1行だけでよい。

## 手順

1. `packages/server/src/modules/agents/<name>/index.ts` を作成し、`IAgentProvider` を実装した
   オブジェクトをエクスポートする(`claude/index.ts` を参考にする)。

   ```ts
   import type { AgentDefinition, IAgentProvider, LaunchOptions } from '../AgentProvider';

   const definition: AgentDefinition = {
     type: 'mytool',
     label: 'My Tool',
     kind: 'cli',
     launchable: true,
     contexts: ['worker'],
     headlessCommand: null,
     models: [],
   };

   function buildLaunchCommand({ model, extraArgs }: LaunchOptions): string | null {
     // tmux ペインでの対話起動コマンドを組み立てる
     return `mytool${model ? ` --model ${model}` : ''}`;
   }

   export const myToolProvider: IAgentProvider = {
     definition,
     buildLaunchCommand,
     buildHeadlessCommand: () => null,      // ヘッドレス(subagent)実行に非対応なら null
     createSessionStrategy: () => null,     // セッション再開に非対応なら null
   };
   ```

2. `packages/server/src/modules/agents/registry.ts` の `createDefaultRegistry()` に登録を1行追加する。

   ```ts
   import { myToolProvider } from './mytool';
   // ...
   registry.register(myToolProvider);
   ```

3. (任意) フロントエンドでアイコン等の見た目を出し分けたい場合は、`type: 'mytool'` を
   キーにした表示コンポーネント側の対応を追加する。API (`/api/agents` 等) は登録した
   `AgentDefinition` を自動的に返すため、サーバー側の追加作業は不要。

## 実装できる項目

`IAgentProvider` の各メンバーは、対応しない場合は素直に `null`(または未実装)を返せばよい。

- `definition`: `/api/agents` `/api/workers/types` `/api/workers/models/:type` で使われるカタログ情報。
- `buildLaunchCommand(opts)`: tmux ペインでの対話起動コマンド(`--model` 等のフラグを組み立てる)。
- `buildHeadlessCommand(model)`: ヘッドレス(subagent 委任)実行コマンド。非対応なら `null`。
- `createSessionStrategy(deps)`: セッション再開(`--resume` 等)の戦略。非対応なら `null`
  (呼び出し側が自動的に `NullSessionStrategy` にフォールバックする)。
- `collectUsage()`: トークン使用量の収集(`/api/usage` に反映される)。実装しなければ
  その種別の使用量は返らないだけで、他のエージェントには影響しない。

## 補足

- 起動コマンド文字列を組み立てる際にモデル名・追加引数をシェルに渡す場合は、
  `shared/shellQuote.ts` の `shellQuote()` を使ってクォートすること
  (`claude/`、`codex/` の実装を参照)。
- `modules/agents/LaunchCommand.ts` の `buildWorkerLaunchCommand` /
  `buildHeadlessLaunchCommand` は、DB に保存された任意の `workerType` 文字列を受け取る
  呼び出し元(タスク実行・プロンプト組み立て等)向けのファサードで、レジストリに存在しない
  型は `extraArgs` をそのままコマンドとして扱う(generic 相当のフォールバック)。

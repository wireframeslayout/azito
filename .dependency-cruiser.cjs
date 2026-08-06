/**
 * dependency-cruiser configuration for packages/server/src.
 *
 * レイヤー構成（依存方向は下記の一方向が原則。上位は下位に依存できるが、逆方向は禁止）:
 *
 *   shared/                                      … 共有基盤（DB 等）。他の modules に依存しない
 *   modules/tmux, modules/servers                … 基盤層。shared のみ依存可。
 *                                                   tmux と servers は互いに深く結合しており（ペイン
 *                                                   ストリーム/トランスポート抽象化が両モジュールに
 *                                                   またがるため）、両方向の依存を許可する。
 *   modules/supervisors                          … 基盤層。shared と servers/Server.ts（サーバー種別の
 *                                                   型のみ）にのみ依存可。tui-supervisor からの
 *                                                   outbound WS を受ける独立した基盤（AZITO監視強化
 *                                                   Phase 3b）。
 *   modules/agents, git, llm, prompt, sidekicks    … 中間層。基盤層 + shared のみ依存可
 *   modules/tasks, windows, units, operations, projects,
 *     files, usage, notifications                 … 上位層。下位すべて・上位層同士に依存可
 *   main.ts / agent/                              … トップ層。すべてに依存可
 *
 * ルールは「現状のコードで実際に発生している依存」を基準に調整してある。
 * 層をまたぐ実在の参照は個別に allow し、コメントで理由を明記している。
 * 「なんでも許可」にはせず、リストにない依存は引き続き error になる。
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'モジュール間の循環依存を禁止する。' +
        '例外: modules/servers/transport/AgentPaneStream.ts と AgentTransport.ts は、' +
        'エージェント経由トランスポートの実装上、双方向参照（値参照とtype参照）が既に存在する。' +
        '同一サブディレクトリ内の実装詳細同士の相互参照であり、src変更を伴わずには解消できないため、' +
        'この2ファイルに限り no-circular の対象から除外する。',
      from: {
        pathNot: [
          '^packages/server/src/modules/servers/transport/AgentPaneStream\\.ts$',
          '^packages/server/src/modules/servers/transport/AgentTransport\\.ts$',
        ],
      },
      to: { circular: true },
    },

    // --- shared: どの modules/ にも依存しない ---
    {
      name: 'shared-no-deps-on-modules',
      severity: 'error',
      comment: 'shared/ は共有基盤（DB等）のみを提供する層であり、modules/ のどれにも依存してはならない。',
      from: { path: '^packages/server/src/shared' },
      to: { path: '^packages/server/src/modules' },
    },

    // --- 基盤層: modules/tmux ---
    {
      name: 'base-tmux-limited-upward',
      severity: 'error',
      comment:
        '基盤層 modules/tmux は modules/servers 以外への依存を原則禁止（servers との関係は tmux⇄servers ' +
        'ペアとして双方向を許可 = 下記 pathNot に列挙した servers 全体）。' +
        '個別の例外: tmux/routes/hooks.ts が notifications/NotificationBus（フック通知のイベント発火）を、' +
        'tmux/routes/sessions.ts が windows/SqliteWindowRepository（セッション一覧とウィンドウ情報の突合）を' +
        '参照している。これは tmux/routes 配下の HTTP インターフェース層としての実装であり、この2箇所に限定する。',
      from: { path: '^packages/server/src/modules/tmux' },
      to: {
        path: '^packages/server/src/modules',
        pathNot: [
          '^packages/server/src/modules/tmux',
          '^packages/server/src/modules/servers',
          '^packages/server/src/modules/notifications/NotificationBus\\.ts$',
          '^packages/server/src/modules/windows/SqliteWindowRepository\\.ts$',
        ],
      },
    },

    // --- 基盤層: modules/servers ---
    {
      name: 'base-servers-limited-upward',
      severity: 'error',
      comment:
        '基盤層 modules/servers は modules/tmux 以外への依存を原則禁止（tmux との関係は tmux⇄servers ' +
        'ペアとして双方向を許可）。個別の例外:\n' +
        '- servers/routes.ts: HTTP インターフェース層として git/DiffParser（差分表示）・' +
        'projects/Project・projects/ProjectServer（プロジェクト⇔サーバー関連付け表示）・' +
        'windows/SqliteWindowRepository（ウィンドウ情報表示）を参照。\n' +
        '- servers/transport/AgentEventStream.ts: notifications/NotificationBus を参照（エージェント' +
        'トランスポート経由のイベント通知のため）。\n' +
        '- servers/agent-deploy/AgentUpdater.ts: units/SqliteUnitRepository・tasks/SqliteTaskRepository ' +
        'を参照（エージェント更新時に実行中タスク/Unit の状態を確認するため）。\n' +
        'いずれも本来は上位層への逆依存であり理想形ではないが、現状の実装として個別に許可する。',
      from: { path: '^packages/server/src/modules/servers' },
      to: {
        path: '^packages/server/src/modules',
        pathNot: [
          '^packages/server/src/modules/servers',
          '^packages/server/src/modules/tmux',
          '^packages/server/src/modules/git/DiffParser\\.ts$',
          '^packages/server/src/modules/projects/Project\\.ts$',
          '^packages/server/src/modules/projects/ProjectServer\\.ts$',
          '^packages/server/src/modules/windows/SqliteWindowRepository\\.ts$',
          '^packages/server/src/modules/notifications/NotificationBus\\.ts$',
          '^packages/server/src/modules/operations/SqliteOperationRepository\\.ts$',
          '^packages/server/src/modules/tasks/SqliteTaskRepository\\.ts$',
        ],
      },
    },

    // --- 基盤層: modules/supervisors ---
    {
      name: 'base-supervisors-limited',
      severity: 'error',
      comment:
        '基盤層 modules/supervisors は shared と servers/Server.ts（ServerConfig 型参照用）以外への' +
        '依存を禁止する。tui-supervisor からの outbound WS を受ける独立した基盤であり、他モジュールと' +
        '結合させない（AZITO監視強化 Phase 3b）。',
      from: { path: '^packages/server/src/modules/supervisors' },
      to: {
        path: '^packages/server/src/modules',
        pathNot: [
          '^packages/server/src/modules/supervisors',
          '^packages/server/src/modules/servers/Server\\.ts$',
        ],
      },
    },

    // --- 中間層: modules/agents, git, llm, prompt ---
    // 中間層は基盤層(tmux/servers)と shared のみ依存可。中間層同士・上位層への依存は
    // 実在する参照だけを個別に allow する。
    {
      name: 'mid-agents-limited',
      severity: 'error',
      comment:
        'modules/agents は基盤層(tmux/servers)以外への依存を原則禁止。' +
        '例外: agents/routes.ts が llm/Provider・llm/LlmClient を参照している（プロバイダ一覧 API のため、mid↔mid）。',
      from: { path: '^packages/server/src/modules/agents' },
      to: {
        path: '^packages/server/src/modules',
        pathNot: [
          '^packages/server/src/modules/agents',
          '^packages/server/src/modules/tmux',
          '^packages/server/src/modules/servers',
          '^packages/server/src/modules/llm/Provider\\.ts$',
          '^packages/server/src/modules/llm/LlmClient\\.ts$',
        ],
      },
    },
    {
      name: 'mid-git-limited',
      severity: 'error',
      comment:
        'modules/git は基盤層(tmux/servers)以外への依存を原則禁止。' +
        '例外: git/providers/GitProviderService.ts が projects/Project を参照している' +
        '（プロジェクトの Git プロバイダ設定を読むため、mid→上位層の逆依存だが現状の実装として許可）。' +
        '（shellQuote は shared/shellQuote.ts に移動済みのため、以前ここにあった agents/shellQuote.ts への' +
        '例外は不要になった — Issue #27 レビュー指摘3。）',
      from: { path: '^packages/server/src/modules/git' },
      to: {
        path: '^packages/server/src/modules',
        pathNot: [
          '^packages/server/src/modules/git',
          '^packages/server/src/modules/tmux',
          '^packages/server/src/modules/servers',
          '^packages/server/src/modules/projects/Project\\.ts$',
        ],
      },
    },
    {
      name: 'mid-llm-limited',
      severity: 'error',
      comment:
        'modules/llm は基盤層(tmux/servers)以外への依存を原則禁止。' +
        '例外: llm/LlmClient.ts が agents/registry（エージェント種別/モデル定義のレジストリ）を参照している（mid↔mid）。',
      from: { path: '^packages/server/src/modules/llm' },
      to: {
        path: '^packages/server/src/modules',
        pathNot: [
          '^packages/server/src/modules/llm',
          '^packages/server/src/modules/tmux',
          '^packages/server/src/modules/servers',
          '^packages/server/src/modules/agents/registry\\.ts$',
        ],
      },
    },
    {
      name: 'mid-prompt-limited',
      severity: 'error',
      comment:
        'modules/prompt は基盤層(tmux/servers)以外への依存を原則禁止。' +
        '例外1: prompt/PhasePromptRenderer.ts が agents/LaunchCommand（起動コマンド組み立て）を参照している（mid↔mid）。' +
        '例外2: prompt/RenderSkillPromptUseCase.ts と PhasePromptRenderer.ts が、' +
        'タスク/プロジェクト/Unit 向けのプロンプトを描画するために tasks/Task・projects/Project・' +
        'projects/ProjectServer・units/Unit（いずれも型定義中心のファイル）を参照している。' +
        '例外3: RenderSkillPromptUseCase.ts が tasks/execution/TaskExecutionEnv.ts の ' +
        'resolveTaskServerName（task.serverName/project_servers からの実行サーバー解決、純粋関数）を参照している' +
        '（Issue #263 Phase 2: WorkerProfile分離）。' +
        '例外4: RenderSkillPromptUseCase.ts が sidekicks/SidekickPackageLoader・sidekicks/resolvePhaseSidekick・' +
        'sidekicks/renderSidekickBody（フェーズプロンプトの解決を phase_prompts テーブルから Sidekick パッケージへ' +
        '切り替え、PhaseLoopRunner と解決規則を共有するため）を参照している（Issue #263 Phase 5、mid↔mid）。\n' +
        '例外5: RenderSkillPromptUseCase.ts と TaskPromptVarsResolver.ts が sidekicks/SidekickSyncService を' +
        '参照している（タスクの実行サーバーが agent の場合に {{sidekick.dir}} をリモートの同期先パスへ' +
        '解決するため。sidekicks モジュールは既に servers 全体への依存が許可されているのでこの参照自体は' +
        '新しい依存方向を作らない、Issue #263 Phase 6、mid↔mid）。',
      from: { path: '^packages/server/src/modules/prompt' },
      to: {
        path: '^packages/server/src/modules',
        pathNot: [
          '^packages/server/src/modules/prompt',
          '^packages/server/src/modules/tmux',
          '^packages/server/src/modules/servers',
          '^packages/server/src/modules/agents/LaunchCommand\\.ts$',
          '^packages/server/src/modules/tasks/Task\\.ts$',
          '^packages/server/src/modules/tasks/execution/TaskExecutionEnv\\.ts$',
          '^packages/server/src/modules/projects/Project\\.ts$',
          '^packages/server/src/modules/projects/ProjectServer\\.ts$',
          '^packages/server/src/modules/units/Unit\\.ts$',
          '^packages/server/src/modules/sidekicks/SidekickPackageLoader\\.ts$',
          '^packages/server/src/modules/sidekicks/SidekickPackage\\.ts$',
          '^packages/server/src/modules/sidekicks/resolvePhaseSidekick\\.ts$',
          '^packages/server/src/modules/sidekicks/renderSidekickBody\\.ts$',
          '^packages/server/src/modules/sidekicks/TaskPhase\\.ts$',
          '^packages/server/src/modules/sidekicks/PhaseConfig\\.ts$',
          '^packages/server/src/modules/sidekicks/ITaskPromptVarsResolver\\.ts$',
          '^packages/server/src/modules/sidekicks/SidekickSyncService\\.ts$',
          '^packages/server/src/modules/sidekicks/UnitType\\.ts$',
          '^packages/server/src/modules/sidekicks/unitTypeSchema\\.ts$',
          '^packages/server/src/modules/sidekicks/UnitTypeLoader\\.ts$',
        ],
      },
    },
    {
      name: 'mid-sidekicks-limited',
      severity: 'error',
      comment:
        'modules/sidekicks は基盤層(tmux/servers)以外への依存を原則禁止（Issue #263 Phase 4: ' +
        'Claude Skill 型のスキルパッケージ基盤）。' +
        '例外1: renderSidekickBody.ts が prompt/promptTemplate.ts の expandPromptTemplate（テンプレート' +
        '変数展開の共通実装）を参照している（mid↔mid）。' +
        '例外2: routes.ts（GET /api/sidekicks/:name?render=1）が prompt/PromptModuleLoader.ts の ' +
        'loadPromptModules（{{module.*}} 変数の読み込み、外部依存のない純粋な参照実装）を参照している' +
        '（Issue #263 Phase 5、mid↔mid）。task/project/unit 系のデータは ITaskPromptVarsResolver.ts ' +
        '（本モジュール側で定義するポート）経由で受け取り、上位層への依存は発生させない。',
      from: { path: '^packages/server/src/modules/sidekicks' },
      to: {
        path: '^packages/server/src/modules',
        pathNot: [
          '^packages/server/src/modules/sidekicks',
          '^packages/server/src/modules/tmux',
          '^packages/server/src/modules/servers',
          '^packages/server/src/modules/prompt/promptTemplate\\.ts$',
          '^packages/server/src/modules/prompt/PromptModuleLoader\\.ts$',
        ],
      },
    },
  ],

  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: {
      path: '\\.test\\.ts$',
    },
    tsPreCompilationDeps: true,
  },
};

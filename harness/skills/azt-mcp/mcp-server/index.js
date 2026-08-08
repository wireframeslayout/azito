#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { azitoGet, azitoPost } from "./lib/client.js";

const server = new Server(
  { name: "azt-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "azt_list_projects",
      description: "azito のプロジェクト一覧を返します",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "azt_create_project",
      description: "azito に新しいプロジェクトを作成します",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "プロジェクト名（必須）" },
          slug: {
            type: "string",
            description:
              "スラッグ（省略時は name から自動生成。小文字英数字とハイフンのみ）",
          },
          description: {
            type: "string",
            description: "プロジェクトの説明（任意）",
          },
          sidekick_prompt: {
            type: "string",
            description: "サイドキック用のプロジェクト固有プロンプト（任意）",
          },
        },
      },
    },
    {
      name: "azt_list_tasks",
      description:
        "azito のタスク一覧を返します。フィルタは project_id / status / unit_id のいずれか1つを指定できます",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "number",
            description: "プロジェクトIDでフィルタ（任意）",
          },
          status: {
            type: "string",
            description:
              "ステータスでフィルタ（任意）: open / in_progress / done / waiting_input 等",
          },
          unit_id: {
            type: "number",
            description: "UnitIDでフィルタ（任意）",
          },
        },
      },
    },
    {
      name: "azt_create_task",
      description: "azito に新しいタスクを作成します",
      inputSchema: {
        type: "object",
        required: ["project_id", "title"],
        properties: {
          project_id: { type: "number", description: "プロジェクトID（必須）" },
          unit_id: {
            type: "number",
            description:
              "UnitID（任意。タスクを遂行するチーム＝ワークフロー定義＋実行ランタイム。azt_list_units で取得。ワークフローを自動実行するタスクでは指定を推奨）",
          },
          title: { type: "string", description: "タスクタイトル（必須）" },
          description: {
            type: "string",
            description: "タスクの詳細説明（任意）",
          },
          priority: {
            type: "number",
            description: "優先度（任意、数値が小さいほど高優先）",
          },
          source: {
            type: "string",
            enum: ["github", "gitlab"],
            description:
              "既存の GitHub/GitLab イシューを読んでタスク化する場合に指定します（任意）。指定すると azito 側でこのタスクは未信頼入力として扱われ、初回実行前に人間の承認が必要になります（source_ref と併せて指定してください）。人間が本文を確認していない自動作成には設定しないでください",
          },
          source_ref: {
            type: "string",
            description: "イシューの参照（例: 'owner/repo#123'）。source 指定時は必須",
          },
        },
      },
    },
    {
      name: "azt_list_units",
      description:
        "azito の Unit（フェーズ→Sidekick マッピング＋実行ランタイムを持つワークフロー定義）一覧を返します。タスク作成時の unit_id 選択に使います",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "azt_list_operations",
      description:
        "azito で現在実行中の Operation（Unit がタスクを遂行している実行ラン）一覧を返します。各要素は unitId / taskId / target を含みます",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "azt_list_sidekicks",
      description:
        "azito の Sidekick（SKILL.md + scripts/ のスキルパッケージ）一覧を返します。name / description / tags / isDefault を含みます（planning/implementing/reviewing/testing/pushing は phase タグとして特別扱い）",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "azt_render_sidekick",
      description:
        "指定した Sidekick のテンプレート変数展開済み本文を取得します。task_id 指定でタスク文脈の {{task.*}}/{{project.*}} を展開し、未指定なら {{sidekick.*}} のみ展開します",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "Sidekick 名（必須）" },
          task_id: {
            type: "number",
            description: "タスクID（任意）。指定するとタスク固有の内容で展開される",
          },
        },
      },
    },
    {
      name: "azt_get_phase_prompt",
      description:
        "azito のフェーズプロンプトを取得します（互換API）。render=skill かつ task_id 指定でタスク固有のプロンプトを返します。内部的には Unit の phase_config が指す Sidekick から解決されます",
      inputSchema: {
        type: "object",
        required: ["phase"],
        properties: {
          phase: {
            type: "string",
            description:
              "フェーズ名（例: planning / implementing / reviewing）",
          },
          task_id: {
            type: "number",
            description:
              "タスクID（render=skill で必須。タスク固有のプロンプトを生成する）",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "azt_list_projects": {
        const result = await azitoGet("/api/projects");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "azt_create_project": {
        const body = { name: args.name };
        if (args.slug !== undefined) body.slug = args.slug;
        if (args.description !== undefined) body.description = args.description;
        if (args.sidekick_prompt !== undefined)
          body.sidekick_prompt = args.sidekick_prompt;
        const result = await azitoPost("/api/projects", body);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "azt_list_tasks": {
        const params = new URLSearchParams();
        if (args.project_id !== undefined)
          params.set("project_id", String(args.project_id));
        else if (args.unit_id !== undefined)
          params.set("unit_id", String(args.unit_id));
        else if (args.status !== undefined) params.set("status", args.status);
        const qs = params.toString();
        const result = await azitoGet(`/api/tasks${qs ? `?${qs}` : ""}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "azt_create_task": {
        const body = {
          project_id: args.project_id,
          unit_id: args.unit_id,
          title: args.title,
        };
        if (args.description !== undefined) body.description = args.description;
        if (args.priority !== undefined) body.priority = args.priority;
        // source/source_ref (task/328-input-trust-and-exec-gate follow-up,
        // part C): passed through verbatim, never defaulted or inferred —
        // an agent creating a task from an issue it read must say so
        // explicitly via `source`. Deliberately NOT auto-approved here (no
        // GET/POST to /api/tasks/:id/execution-approval): unlike the
        // browser's interactive create-form, no human has reviewed this
        // content, so an untrusted task created through this tool must still
        // go through the normal pending_approval panel on first execute.
        if (args.source !== undefined) body.source = args.source;
        if (args.source_ref !== undefined) body.source_ref = args.source_ref;
        const result = await azitoPost("/api/tasks", body);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "azt_list_units": {
        const result = await azitoGet("/api/units");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "azt_list_operations": {
        const result = await azitoGet("/api/operations");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "azt_list_sidekicks": {
        const result = await azitoGet("/api/sidekicks");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "azt_render_sidekick": {
        const params = new URLSearchParams({ render: "1" });
        if (args.task_id !== undefined) params.set("task_id", String(args.task_id));
        const result = await azitoGet(
          `/api/sidekicks/${encodeURIComponent(args.name)}?${params.toString()}`
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "azt_get_phase_prompt": {
        const params = new URLSearchParams();
        if (args.task_id !== undefined) {
          params.set("render", "skill");
          params.set("task_id", String(args.task_id));
        }
        const qs = params.toString();
        const result = await azitoGet(
          `/api/phase-prompts/${args.phase}${qs ? `?${qs}` : ""}`
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      default:
        throw new Error(`未知のツール: ${name}`);
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `エラー: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// scripted fake agent（fake-agent/task-agent）にタスクを 1 本流し、review になるまで待つ共通手順。
// misao の窓で「タスク実行 → 完了検知」が通ることを確かめる spec が共有する。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import type { Harness } from './harness';

const NO_SUBAGENT = { enabled: false, provider: '', model: '' };
const TASK_AGENT_PATH = path.join(__dirname, 'fake-agent', 'task-agent');

/** タスク実行（窓作成 → コマンド送出 → プロンプト往復 → 完了検知）に許す最大時間。 */
export const TASK_BUDGET_MS = 60_000;

/** 空の初期コミットだけを持つ git リポジトリ（タスクの作業ディレクトリ）。呼び出し側が rmSync する。 */
export function createGitRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-e2e-repo-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'e2e@example.invalid');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(repo, 'README.md'), 'e2e\n');
  git('add', '.');
  git('commit', '-m', 'init');
  return repo;
}

/** POSIX シェル向けの単一引数クォート。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * implementing だけを有効にした Unit（worker は scripted fake）でタスクを作って実行し、`review` になるまで待つ。
 * 返すのはタスク ID。サーバー名は `local`、作業ディレクトリは `repo`。
 */
export async function runScriptedTaskToReview(
  harness: Harness,
  projectId: number,
  repo: string,
  names: { unit: string; title: string },
): Promise<number> {
  await harness.api(`/projects/${projectId}/servers/local`, {
    method: 'PUT',
    body: JSON.stringify({ working_directory: repo }),
  });
  const phaseConfig = Object.fromEntries(
    ['planning', 'reviewing', 'testing', 'pushing'].map((phase) => [phase, { enabled: false }]),
  );
  const { id: unitId } = await harness.api<{ id: number }>('/units', {
    method: 'POST',
    body: JSON.stringify({
      name: names.unit,
      worker_type: 'generic',
      worker_extra_args: `${shellQuote(process.execPath)} ${shellQuote(TASK_AGENT_PATH)}`,
      phase_config: phaseConfig,
      // POST /api/units は省略された subagent 設定を JSON の "null" として保存し、読み戻しで
      // 失敗する（既存の不具合）。明示的に「無効」を渡して避ける。
      review_subagent: NO_SUBAGENT,
      implement_subagent: NO_SUBAGENT,
    }),
  });
  const { id: taskId } = await harness.api<{ id: number }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      project_id: projectId,
      unit_id: unitId,
      server_name: 'local',
      title: names.title,
      description: 'e2e: scripted fake agent completes this task',
      base_branch: 'main',
      skip_pr: true,
      require_plan_approval: false,
    }),
  });

  await harness.api(`/units/${unitId}/execute`, { method: 'POST', body: JSON.stringify({ taskId, force: true }) });

  await expect.poll(async () => (await harness.api<{ status: string }>(`/tasks/${taskId}`)).status, {
    timeout: TASK_BUDGET_MS,
  }).toBe('review');
  return taskId;
}

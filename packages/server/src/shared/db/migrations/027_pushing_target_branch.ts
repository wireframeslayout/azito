import type Database from 'better-sqlite3';

export const version = 27;
export const description = 'Update pushing phase prompt to support target branch';

export function up(db: Database.Database): void {
  const updatePhase = db.prepare(`UPDATE phase_prompts SET prompt = ? WHERE phase = ?`);
  updatePhase.run(`<task>
Push the implementation and create a Pull Request.
</task>

<rules>
- Base branch: {{project.defaultBranch}}
{{task.targetBranch}}
- PR title should concisely describe the task
- PR body should include a summary of changes and test results

{{project.sidekickPrompt}}
</rules>

<output>
Report the PR URL.
Report "PHASE_COMPLETE" when done.
</output>`, 'pushing');
}

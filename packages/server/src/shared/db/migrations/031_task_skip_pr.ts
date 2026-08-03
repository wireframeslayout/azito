import type Database from 'better-sqlite3';

export const version = 31;
export const description = 'Add skip_pr to tasks and update pushing prompt';

export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE tasks ADD COLUMN skip_pr INTEGER NOT NULL DEFAULT 0`);

  const updatePhase = db.prepare(`UPDATE phase_prompts SET prompt = ? WHERE phase = ?`);
  updatePhase.run(`<task>
{{task.pushTaskDescription}}
</task>

<rules>
- Base branch: {{project.defaultBranch}}
{{task.targetBranch}}
{{task.pushRules}}

{{project.sidekickPrompt}}
</rules>

<output>
{{task.pushOutput}}
Report "PHASE_COMPLETE" when done.
</output>`, 'pushing');
}

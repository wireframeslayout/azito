import type Database from 'better-sqlite3';

export const version = 33;
export const description = 'Update pushing prompt to fully support skip_pr mode';

export function up(db: Database.Database): void {
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

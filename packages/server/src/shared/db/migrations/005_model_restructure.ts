import type { Database } from 'better-sqlite3';

export const version = 5;
export const description = 'Restructure models: project_servers, phase_prompts, sidekick/task updates';

export function up(db: Database): void {
  // ─── project_servers (replaces project_windows) ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_servers (
      project_id INTEGER NOT NULL,
      server_name TEXT NOT NULL,
      working_directory TEXT,
      branch TEXT,
      PRIMARY KEY (project_id, server_name),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (server_name) REFERENCES servers(name) ON DELETE CASCADE
    )
  `);

  // Migrate data from project_windows to project_servers (deduplicated)
  const existingWindows = db.prepare(`
    SELECT DISTINCT project_id, server_name FROM project_windows
  `).all() as Array<{ project_id: number; server_name: string }>;

  const insertProjectServer = db.prepare(`
    INSERT OR IGNORE INTO project_servers (project_id, server_name) VALUES (?, ?)
  `);
  for (const row of existingWindows) {
    insertProjectServer.run(row.project_id, row.server_name);
  }

  // ─── phase_prompts ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS phase_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT NOT NULL UNIQUE,
      prompt TEXT NOT NULL,
      "order" INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Seed default phase prompts
  const insertPhase = db.prepare(`
    INSERT OR IGNORE INTO phase_prompts (phase, prompt, "order", enabled) VALUES (?, ?, ?, 1)
  `);

  insertPhase.run('planning', `<task>
Analyze the task and create an implementation plan.
Title: {{task.title}}
Details: {{task.description}}
</task>

<rules>
{{project.sidekickPrompt}}
</rules>

<output>
Summarize concisely:
- Target files and changes
- Implementation steps (numbered)
- Impact scope and risks

Report "PHASE_COMPLETE" when the plan is ready.
</output>`
  , 1);

  insertPhase.run('implementing', `<task>
Implement according to the plan.
Title: {{task.title}}
Working directory: {{projectServer.workingDirectory}}
</task>

<rules>
{{project.sidekickPrompt}}

If this is a git repository:
- Create a working branch from {{project.defaultBranch}}
- Name the branch based on the task content
- Commit frequently with clear messages
</rules>

<output>
Report "PHASE_COMPLETE" when implementation is done.
If you have questions that need human input, report them prefixed with "QUESTION:".
</output>`
  , 2);

  insertPhase.run('reviewing', `<task>
Review your own implementation. (Attempt {{selfReview.attempt}}/{{selfReview.maxAttempts}})
</task>

<rules>
Check the diff against these criteria:
1. Task requirements are met
2. Project rules are followed
3. No bugs or missed edge cases
4. No unnecessary code or comments
5. No security issues

{{project.sidekickPrompt}}
</rules>

<output>
Fix any problems you find.
Report "PHASE_COMPLETE" if everything looks good.
</output>`
  , 3);

  insertPhase.run('testing', `<task>
Run tests for the implemented code.
</task>

<rules>
- Verify existing tests are not broken
- Run the test suite if available
- Run type checking (tsc --noEmit, etc.) if available
- Add new tests if needed

{{project.sidekickPrompt}}
</rules>

<output>
Report test results.
Report "PHASE_COMPLETE" if all tests pass.
If tests fail, report the failures prefixed with "TEST_FAILED:".
</output>`
  , 4);

  insertPhase.run('pushing', `<task>
Push the implementation and create a Pull Request.
</task>

<rules>
- Base branch: {{project.defaultBranch}}
- PR title should concisely describe the task
- PR body should include a summary of changes and test results

{{project.sidekickPrompt}}
</rules>

<output>
Report the PR URL.
Report "PHASE_COMPLETE" when done.
</output>`
  , 5);

  // ─── Add columns to sidekicks ───
  const sidekickColumns = [
    { name: 'orchestrator_mode', sql: "ALTER TABLE sidekicks ADD COLUMN orchestrator_mode TEXT NOT NULL DEFAULT 'state-machine'" },
    { name: 'worker_type', sql: "ALTER TABLE sidekicks ADD COLUMN worker_type TEXT" },
    { name: 'self_review_max_attempts', sql: "ALTER TABLE sidekicks ADD COLUMN self_review_max_attempts INTEGER NOT NULL DEFAULT 2" },
  ];

  for (const col of sidekickColumns) {
    try {
      db.exec(col.sql);
    } catch {
      // column may already exist
    }
  }

  // Populate worker_type from worker_command where possible
  db.exec(`
    UPDATE sidekicks SET worker_type = CASE
      WHEN worker_command LIKE '%claude%' THEN 'claude'
      WHEN worker_command LIKE '%codex%' THEN 'codex'
      WHEN worker_command LIKE '%aider%' THEN 'aider'
      ELSE 'generic'
    END
    WHERE worker_type IS NULL
  `);

  // ─── Add columns to tasks ───
  const taskColumns = [
    { name: 'self_review_count', sql: "ALTER TABLE tasks ADD COLUMN self_review_count INTEGER NOT NULL DEFAULT 0" },
  ];

  for (const col of taskColumns) {
    try {
      db.exec(col.sql);
    } catch {
      // column may already exist
    }
  }

  // ─── Add columns to projects ───
  const projectColumns = [
    { name: 'repository_url', sql: "ALTER TABLE projects ADD COLUMN repository_url TEXT" },
    { name: 'default_branch', sql: "ALTER TABLE projects ADD COLUMN default_branch TEXT DEFAULT 'main'" },
  ];

  for (const col of projectColumns) {
    try {
      db.exec(col.sql);
    } catch {
      // column may already exist
    }
  }
}

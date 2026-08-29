import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../Database';

// openDatabase(':memory:') runs the full migration chain (001->067) against
// a fresh in-memory DB — same as production — so this test exercises the
// real rebuilt `tasks` table (see 067_task_distribution_repository.ts's own
// doc comment for why a full rename/create/copy/drop rebuild was needed
// instead of a plain ALTER TABLE ADD COLUMN).
describe('migration 067: task_distribution_repository', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, name, slug) VALUES (1, 'Test Project', 'test-project')`).run();
    db.prepare(`INSERT INTO servers (name, type) VALUES ('srv-agent', 'agent')`).run();
  });

  it('adds distribution_repository_id defaulting to NULL for an existing task row', () => {
    db.prepare(`INSERT INTO tasks (id, project_id, title, server_name) VALUES (1, 1, 'Task 1', 'srv-agent')`).run();

    const row = db.prepare(`SELECT distribution_repository_id FROM tasks WHERE id = 1`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBeNull();
  });

  it('accepts an explicit distribution_repository_id pointing at a project_repositories row', () => {
    const repoId = db.prepare(`INSERT INTO project_repositories (project_id, url, provider) VALUES (1, 'https://github.com/acme/widget.git', 'github')`).run().lastInsertRowid as number;
    db.prepare(`INSERT INTO tasks (id, project_id, title, server_name, distribution_repository_id) VALUES (1, 1, 'Task 1', 'srv-agent', ?)`).run(repoId);

    const row = db.prepare(`SELECT distribution_repository_id FROM tasks WHERE id = 1`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBe(repoId);
  });

  it('SETs NULL the task\'s distribution_repository_id when the referenced repository is deleted', () => {
    const repoId = db.prepare(`INSERT INTO project_repositories (project_id, url, provider) VALUES (1, 'https://github.com/acme/widget.git', 'github')`).run().lastInsertRowid as number;
    db.prepare(`INSERT INTO tasks (id, project_id, title, server_name, distribution_repository_id) VALUES (1, 1, 'Task 1', 'srv-agent', ?)`).run(repoId);

    let row = db.prepare(`SELECT distribution_repository_id FROM tasks WHERE id = 1`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBe(repoId);

    db.prepare(`DELETE FROM project_repositories WHERE id = ?`).run(repoId);

    row = db.prepare(`SELECT distribution_repository_id FROM tasks WHERE id = 1`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBeNull();
  });

  it('does not delete or otherwise disturb the task itself when the referenced repository is deleted', () => {
    const repoId = db.prepare(`INSERT INTO project_repositories (project_id, url, provider) VALUES (1, 'https://github.com/acme/widget.git', 'github')`).run().lastInsertRowid as number;
    db.prepare(`INSERT INTO tasks (id, project_id, title, server_name, distribution_repository_id, worktree_branch) VALUES (1, 1, 'Task 1', 'srv-agent', ?, 'task/1-slug')`).run(repoId);

    db.prepare(`DELETE FROM project_repositories WHERE id = ?`).run(repoId);

    const row = db.prepare(`SELECT title, worktree_branch FROM tasks WHERE id = 1`).get() as { title: string; worktree_branch: string | null };
    expect(row.title).toBe('Task 1');
    expect(row.worktree_branch).toBe('task/1-slug');
  });

  it('still enforces every other FK/index behavior the tasks table already had (server_name ON DELETE SET NULL, project cascade)', () => {
    db.prepare(`INSERT INTO tasks (id, project_id, title, server_name) VALUES (1, 1, 'Task 1', 'srv-agent')`).run();

    db.prepare(`DELETE FROM servers WHERE name = 'srv-agent'`).run();
    let row = db.prepare(`SELECT server_name FROM tasks WHERE id = 1`).get() as { server_name: string | null };
    expect(row.server_name).toBeNull();

    db.prepare(`DELETE FROM projects WHERE id = 1`).run();
    const afterProjectDelete = db.prepare(`SELECT server_name FROM tasks WHERE id = 1`).get();
    expect(afterProjectDelete).toBeUndefined();
  });

  it('preserves the created_by index (idx_tasks_created_by) rebuilt after the table rename', () => {
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'`).all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_tasks_created_by');
  });
});

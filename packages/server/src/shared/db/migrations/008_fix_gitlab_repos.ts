import type { Database } from 'better-sqlite3';

export const version = 8;
export const description = 'Auto-populate owner/repo_name for GitLab repositories from URL';

export function up(db: Database): void {
  const rows = db.prepare('SELECT id, url, provider FROM project_repositories WHERE owner IS NULL OR repo_name IS NULL').all() as Array<{ id: number; url: string; provider: string }>;
  const update = db.prepare('UPDATE project_repositories SET owner = ?, repo_name = ?, provider = ? WHERE id = ?');
  for (const row of rows) {
    // GitHub
    const ghMatch = row.url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (ghMatch) {
      update.run(ghMatch[1], ghMatch[2], 'github', row.id);
      continue;
    }
    // GitLab (gitlab.com or self-hosted with "gitlab" in hostname)
    const glMatch = row.url.match(/gitlab[^/]*[/:]([\w.-]+(?:\/[\w.-]+)*)\/([\w.-]+?)(?:\.git)?$/);
    if (glMatch) {
      update.run(glMatch[1], glMatch[2], 'gitlab', row.id);
      continue;
    }
  }
}

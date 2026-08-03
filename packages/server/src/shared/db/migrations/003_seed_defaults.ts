import type { Database } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export const version = 3;
export const description = 'Seed default providers and local server';

export function up(db: Database): void {
  // Seed default LLM providers
  const insertProvider = db.prepare('INSERT OR IGNORE INTO llm_providers (id, name, type, api_key, base_url) VALUES (?, ?, ?, ?, ?)');
  insertProvider.run('openai', 'OpenAI', 'openai', null, null);
  insertProvider.run('anthropic', 'Anthropic', 'anthropic', null, null);

  // Seed local server if none exist
  const hasLocal = db.prepare('SELECT 1 FROM servers WHERE name = ?').get('local');
  if (!hasLocal) {
    const configPath = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'servers.json');
    if (fs.existsSync(configPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const insert = db.prepare('INSERT OR IGNORE INTO servers (name, type, host) VALUES (?, ?, ?)');
        for (const s of raw.servers) {
          insert.run(s.name, s.type, s.host || null);
        }
      } catch {}
    } else {
      db.prepare('INSERT INTO servers (name, type) VALUES (?, ?)').run('local', 'local');
    }
  }
}

import Database from 'better-sqlite3';
import path from 'path';
import { seal, open } from '../packages/server/src/shared/crypto/SecretBox';

const DB_PATH = path.resolve(__dirname, '..', 'data.db');
const db = new Database(DB_PATH);

function reseal(table: string, idCol: string, secretCol: string): number {
  const rows = db.prepare(`SELECT ${idCol}, ${secretCol} FROM ${table} WHERE ${secretCol} IS NOT NULL`).all() as Array<Record<string, unknown>>;
  const stmt = db.prepare(`UPDATE ${table} SET ${secretCol} = ? WHERE ${idCol} = ?`);
  let count = 0;
  for (const row of rows) {
    const raw = row[secretCol] as string;
    const plain = open(raw) as string;
    const sealed = seal(plain) as string;
    if (sealed !== raw) {
      stmt.run(sealed, row[idCol]);
      count++;
    }
  }
  return count;
}

console.log('Sealing existing secrets...');
console.log('  llm_providers.api_key:', reseal('llm_providers', 'id', 'api_key'));
console.log('  servers.agent_token:', reseal('servers', 'name', 'agent_token'));
console.log('  project_repositories.token:', reseal('project_repositories', 'id', 'token'));
console.log('  project_secrets.value:', reseal('project_secrets', 'id', 'value'));

const storageRow = db.prepare('SELECT access_key, secret_key FROM storage_settings WHERE id = 1').get() as { access_key: string; secret_key: string } | undefined;
if (storageRow) {
  let storageCount = 0;
  const ak = open(storageRow.access_key) as string;
  const sk = open(storageRow.secret_key) as string;
  const sakSealed = seal(ak) as string;
  const sskSealed = seal(sk) as string;
  if (sakSealed !== storageRow.access_key || sskSealed !== storageRow.secret_key) {
    db.prepare('UPDATE storage_settings SET access_key = ?, secret_key = ? WHERE id = 1').run(sakSealed, sskSealed);
    storageCount = 1;
  }
  console.log('  storage_settings.access_key/secret_key:', storageCount);
}

console.log('Done.');
db.close();

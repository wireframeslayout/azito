import type { SqliteDatabase } from '../../shared/db/Database';
import type { LlmProvider, ProviderType, IProviderRepository } from './Provider';
import { seal, open } from '../../shared/crypto/SecretBox';

interface ProviderRow {
  id: string;
  name: string;
  type: string;
  api_key: string | null;
  base_url: string | null;
  created_at: string;
}

export class SqliteProviderRepository implements IProviderRepository {
  private listStmt;
  private getStmt;
  private createStmt;
  private updateStmt;
  private deleteStmt;

  constructor(private db: SqliteDatabase) {
    this.listStmt = db.prepare('SELECT * FROM llm_providers ORDER BY created_at');
    this.getStmt = db.prepare('SELECT * FROM llm_providers WHERE id = ?');
    this.createStmt = db.prepare('INSERT INTO llm_providers (id, name, type, api_key, base_url) VALUES (?, ?, ?, ?, ?)');
    this.updateStmt = db.prepare('UPDATE llm_providers SET name = ?, type = ?, api_key = ?, base_url = ? WHERE id = ?');
    this.deleteStmt = db.prepare('DELETE FROM llm_providers WHERE id = ?');
  }

  findAll(): LlmProvider[] {
    return (this.listStmt.all() as ProviderRow[]).map((r) => this.toEntity(r));
  }

  findById(id: string): LlmProvider | null {
    const row = this.getStmt.get(id) as ProviderRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  create(data: Omit<LlmProvider, 'createdAt'>): void {
    this.createStmt.run(data.id, data.name, data.type, seal(data.apiKey ?? null), data.baseUrl ?? null);
  }

  update(id: string, data: Partial<LlmProvider>): void {
    const current = this.getStmt.get(id) as ProviderRow | undefined;
    if (!current) return;
    const nextKey = data.apiKey !== undefined ? seal(data.apiKey) : current.api_key;
    this.updateStmt.run(
      data.name ?? current.name,
      data.type ?? current.type,
      nextKey,
      data.baseUrl ?? current.base_url,
      id,
    );
  }

  delete(id: string): void {
    this.deleteStmt.run(id);
  }

  private toEntity(row: ProviderRow): LlmProvider {
    return {
      id: row.id,
      name: row.name,
      type: row.type as ProviderType,
      apiKey: open(row.api_key),
      baseUrl: row.base_url,
      createdAt: row.created_at,
    };
  }
}

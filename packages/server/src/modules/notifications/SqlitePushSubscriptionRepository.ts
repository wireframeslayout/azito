import type { SqliteDatabase } from '../../shared/db/Database';

export interface PushSubscriptionRecord {
  id: number;
  endpoint: string;
  keysP256dh: string;
  keysAuth: string;
  createdAt: string;
  lang: string;
}

interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
  created_at: string;
  lang: string;
}

export class SqlitePushSubscriptionRepository {
  private listStmt;
  private createStmt;
  private deleteStmt;
  private findByEndpointStmt;
  private countStmt;
  private deleteOldestStmt;

  constructor(private db: SqliteDatabase) {
    this.listStmt = db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at');
    this.createStmt = db.prepare(
      'INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, lang) VALUES (?, ?, ?, ?)',
    );
    this.deleteStmt = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
    this.findByEndpointStmt = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?');
    this.countStmt = db.prepare('SELECT COUNT(*) as cnt FROM push_subscriptions');
    this.deleteOldestStmt = db.prepare('DELETE FROM push_subscriptions WHERE id = (SELECT id FROM push_subscriptions ORDER BY created_at ASC LIMIT 1)');
  }

  findAll(): PushSubscriptionRecord[] {
    return (this.listStmt.all() as PushSubscriptionRow[]).map((r) => this.toEntity(r));
  }

  findByEndpoint(endpoint: string): PushSubscriptionRecord | null {
    const row = this.findByEndpointStmt.get(endpoint) as PushSubscriptionRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  create(endpoint: string, p256dh: string, auth: string, lang = 'en'): void {
    const existing = this.findByEndpointStmt.get(endpoint) as PushSubscriptionRow | undefined;
    if (!existing) {
      const { cnt } = this.countStmt.get() as { cnt: number };
      if (cnt >= 20) {
        this.deleteOldestStmt.run();
      }
    }
    this.createStmt.run(endpoint, p256dh, auth, lang);
  }

  deleteByEndpoint(endpoint: string): void {
    this.deleteStmt.run(endpoint);
  }

  private toEntity(row: PushSubscriptionRow): PushSubscriptionRecord {
    return {
      id: row.id,
      endpoint: row.endpoint,
      keysP256dh: row.keys_p256dh,
      keysAuth: row.keys_auth,
      createdAt: row.created_at,
      lang: row.lang,
    };
  }
}

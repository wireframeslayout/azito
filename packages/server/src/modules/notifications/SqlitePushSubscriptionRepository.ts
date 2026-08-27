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

  constructor(private db: SqliteDatabase) {
    this.listStmt = db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at');
    this.createStmt = db.prepare(
      'INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, lang) VALUES (?, ?, ?, ?)',
    );
    this.deleteStmt = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
    this.findByEndpointStmt = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?');
  }

  findAll(): PushSubscriptionRecord[] {
    return (this.listStmt.all() as PushSubscriptionRow[]).map((r) => this.toEntity(r));
  }

  findByEndpoint(endpoint: string): PushSubscriptionRecord | null {
    const row = this.findByEndpointStmt.get(endpoint) as PushSubscriptionRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  // endpoint is UNIQUE + INSERT OR REPLACE (migration 011), so duplicates are
  // impossible. Rows that 404/410 are pruned by PushNotificationService on send;
  // rows that persistently 400/403 (e.g. VAPID mismatch) are NOT auto-pruned —
  // they remain harmless until the client re-subscribes with a fresh endpoint.
  create(endpoint: string, p256dh: string, auth: string, lang = 'en'): void {
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

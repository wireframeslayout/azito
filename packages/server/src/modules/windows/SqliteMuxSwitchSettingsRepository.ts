import type { Database } from 'better-sqlite3';

export type MuxSwitchPolicy = 'ask' | 'misao' | 'tmux';

export class SqliteMuxSwitchSettingsRepository {
  constructor(private readonly db: Database) {}

  get(): MuxSwitchPolicy {
    const row = this.db.prepare('SELECT policy FROM mux_switch_settings WHERE id = 1').get() as { policy: MuxSwitchPolicy };
    return row.policy;
  }

  set(policy: MuxSwitchPolicy): void {
    this.db.prepare('UPDATE mux_switch_settings SET policy = ? WHERE id = 1').run(policy);
  }
}

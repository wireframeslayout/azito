import type Database from 'better-sqlite3';

export const version = 40;
export const description = 'Add operations.phase_config, carry over phase_prompts.enabled=false as a per-operation default, drop phase_prompts (Issue #263 Phase 5)';

/**
 * Phase 5 of the Sidekick redesign (Issue #263): phase-prompt resolution moves
 * from the global `phase_prompts` table to Sidekick packages (see
 * modules/sidekicks/resolvePhaseSidekick.ts). `operations.phase_config` lets
 * each Operation override, per phase, which Sidekick package to use and
 * whether the phase is enabled at all.
 *
 * `phase_prompts.enabled` used to be a *global* toggle (applied to every
 * Operation). To avoid silently re-enabling phases that an operator had
 * disabled, any phase with `enabled = 0` is carried over into every existing
 * Operation's `phase_config` as `{ <phase>: { enabled: false } }` before the
 * table is dropped. This must run before the DROP so the enabled flags are
 * still readable. If no phase was disabled, `phase_config` is left NULL
 * (falls through to Sidekick package defaults for every phase).
 */
export function up(db: Database.Database): void {
  db.exec('ALTER TABLE operations ADD COLUMN phase_config TEXT');

  const disabledPhases = (
    db.prepare('SELECT phase FROM phase_prompts WHERE enabled = 0').all() as Array<{ phase: string }>
  ).map((r) => r.phase);

  if (disabledPhases.length > 0) {
    const initialPhaseConfig: Record<string, { enabled: false }> = {};
    for (const phase of disabledPhases) {
      initialPhaseConfig[phase] = { enabled: false };
    }
    const json = JSON.stringify(initialPhaseConfig);

    const operationIds = (db.prepare('SELECT id FROM operations').all() as Array<{ id: number }>).map((r) => r.id);
    const setPhaseConfig = db.prepare('UPDATE operations SET phase_config = ? WHERE id = ?');
    for (const id of operationIds) {
      setPhaseConfig.run(json, id);
    }
    console.log(`[migration 040] Carried over disabled phases [${disabledPhases.join(', ')}] into phase_config for ${operationIds.length} operation(s).`);
  }

  db.exec('DROP TABLE phase_prompts');
}

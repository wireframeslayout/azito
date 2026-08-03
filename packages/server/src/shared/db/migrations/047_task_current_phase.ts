export const version = 47;
export const description = 'Add current_phase column to tasks; separate phase names from status';

export function up(db: import('better-sqlite3').Database): void {
  db.exec(`ALTER TABLE tasks ADD COLUMN current_phase TEXT`);

  db.exec(`
    UPDATE tasks SET current_phase = status, status = 'running'
    WHERE status IN ('planning', 'implementing', 'reviewing', 'testing', 'pushing')
  `);

  db.exec(`
    UPDATE tasks SET status = 'phase_review', current_phase = 'planning'
    WHERE status = 'planning_review'
  `);

  // waiting_input tasks: set current_phase to 'planning' as legacy fallback
  // (old taskStatusToPhase always mapped waiting_input -> planning)
  db.exec(`
    UPDATE tasks SET current_phase = 'planning'
    WHERE status = 'waiting_input' AND current_phase IS NULL
  `);
}

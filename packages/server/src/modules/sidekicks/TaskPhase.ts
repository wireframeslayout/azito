// ─── TaskPhase: the fixed 5-phase task execution vocabulary ───

const PHASE_NAMES = ['planning', 'implementing', 'reviewing', 'testing', 'pushing'] as const;
export type TaskPhase = typeof PHASE_NAMES[number];

function isPhaseTagValue(value: string): value is TaskPhase {
  return (PHASE_NAMES as readonly string[]).includes(value);
}

/** そのタグが5つの phase タグ（planning/implementing/reviewing/testing/pushing）のいずれかか。 */
export function isPhaseTag(tag: string): tag is TaskPhase {
  return isPhaseTagValue(tag);
}

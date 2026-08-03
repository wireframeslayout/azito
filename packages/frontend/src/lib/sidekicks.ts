export const SIDEKICK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSidekickName(name: string): boolean {
  return SIDEKICK_NAME_PATTERN.test(name);
}

export interface SidekickMeta {
  name: string;
  description: string;
  tags: string[];
  isDefault: boolean;
  layer: 'builtin' | 'user';
  overridesBuiltin: boolean;
  hasScripts: boolean;
  hasReferences: boolean;
}

const OTHER_GROUP_LABEL = 'Other';

export function groupSidekicksByPhase<T extends { tags: string[] }>(
  sidekicks: T[],
  phases: Array<{ name: string; label: string }>,
): Array<{ label: string; items: T[] }> {
  const phaseNames = phases.map((p) => p.name);
  const byKey = new Map<string, T[]>();
  for (const name of phaseNames) byKey.set(name, []);
  byKey.set('other', []);

  for (const s of sidekicks) {
    const phaseTags = phaseNames.filter((p) => s.tags.includes(p));
    if (phaseTags.length === 0) {
      byKey.get('other')!.push(s);
    } else {
      for (const phase of phaseTags) byKey.get(phase)!.push(s);
    }
  }

  return [...phaseNames, 'other']
    .map((key) => ({
      label: key === 'other' ? OTHER_GROUP_LABEL : (phases.find((p) => p.name === key)?.label ?? key),
      items: byKey.get(key) ?? [],
    }))
    .filter((group) => group.items.length > 0);
}

export function collectAllTags<T extends { tags: string[] }>(
  sidekicks: T[],
  phaseNames: string[],
): string[] {
  const seen = new Set<string>();
  const freeTags: string[] = [];
  for (const s of sidekicks) {
    for (const tag of s.tags) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      if (!phaseNames.includes(tag)) freeTags.push(tag);
    }
  }
  const orderedPhaseTags = phaseNames.filter((p) => seen.has(p));
  return [...orderedPhaseTags, ...freeTags];
}

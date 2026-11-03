export function parseWindowId(value: string): number | null {
  const match = /^(?:[Ww]-?)?([0-9]+)$/.exec(value);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function formatWindowId(id: number): string {
  return `W-${id}`;
}

const INTERNAL_WINDOW_NAME = /^(?:win|task-\d+)--[a-z0-9]{4}$/;
export function isInternalWindowName(name: string | undefined | null): boolean {
  return !!name && INTERNAL_WINDOW_NAME.test(name.trim());
}

const GENERATED_SUFFIX = /^(.+)--[a-z0-9]{4}$/;
export function stripGeneratedSuffix(name: string): string {
  const m = name.match(GENERATED_SUFFIX);
  return m ? m[1] : name;
}

export function formatWindowId(id: number): string {
  return `W-${id}`;
}

const INTERNAL_WINDOW_NAME = /^(?:win|task-\d+)--[a-z0-9]{4}$/;
export function isInternalWindowName(name: string | undefined | null): boolean {
  return !!name && INTERNAL_WINDOW_NAME.test(name.trim());
}

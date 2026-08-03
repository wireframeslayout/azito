export function generateWindowName(baseName: string = 'win'): string {
  const stripped = stripWindowId(baseName);
  const id = Math.random().toString(36).substring(2, 6);
  return `${stripped}--${id}`;
}

export function stripWindowId(name: string): string {
  return name.replace(/--[a-z0-9]{4}$/, '');
}

export function extractWindowId(name: string): string | null {
  const match = name.match(/--([a-z0-9]{4})$/);
  return match ? match[1] : null;
}

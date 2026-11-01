export function storageRelativeKey(projectId: number, key: string): string {
  const prefix = `projects/${projectId}/`;
  if (!key.startsWith(prefix) || key.length === prefix.length) throw new Error('Invalid storage key');
  return key.slice(prefix.length);
}

export function expandPromptTemplate(
  template: string,
  vars: Record<string, Record<string, string>>,
  keepUnknown = false,
): string {
  return template.replace(/\{\{(\w+)\.(\w+)\}\}/g, (match, group, key) => {
    if (keepUnknown && vars[group]?.[key] === undefined) return match;
    return vars[group]?.[key] ?? '';
  });
}

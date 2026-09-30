const PANE_SUFFIX_RE = /\.\d+$/;

export function stripPaneSuffix(target: string): string {
  return target.replace(PANE_SUFFIX_RE, '');
}

export function isSameWindowTarget(a: string, b: string): boolean {
  return stripPaneSuffix(a) === stripPaneSuffix(b);
}

export function windowKey(serverName: string, target: string): string {
  return `${serverName}::${stripPaneSuffix(target)}`;
}

export function isRelayRoutingName(name: string | null | undefined, names: readonly (string | null | undefined)[]): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 128 && name.trim() === name && !/[\x00-\x1f\x7f-\x9f]/.test(name) && names.filter(item => item === name).length === 1;
}

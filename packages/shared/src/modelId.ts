const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]*(\[[A-Za-z0-9]+\])?$/;
const MAX_MODEL_ID_LENGTH = 64;

export function isValidModelId(id: string): boolean {
  if (!id || id.length > MAX_MODEL_ID_LENGTH) return false;
  return MODEL_ID_RE.test(id);
}

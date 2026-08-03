export const SAFE_PATH_PATTERN = /^[a-zA-Z0-9_./@:~-][a-zA-Z0-9_./@:~-]*$/;
export const SAFE_BRANCH_PATTERN = /^[a-zA-Z0-9_./-]+$/;

export function assertSafePath(value: string, label: string): void {
  if (!SAFE_PATH_PATTERN.test(value)) throw new Error(`Unsafe ${label}: ${value}`);
}

export function assertSafeBranch(value: string, label: string): void {
  if (!SAFE_BRANCH_PATTERN.test(value)) throw new Error(`Unsafe ${label}: ${value}`);
}

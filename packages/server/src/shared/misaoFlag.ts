// Single source for the AZITO_EXPERIMENTAL_MISAO flag. Read once at the
// composition root (app/wiring.ts) and threaded through as a resolved boolean
// (Resolve at the Boundary), same shape as auth/scopedAuthFlag.ts.
export function resolveMisaoEnabled(): boolean {
  return process.env.AZITO_EXPERIMENTAL_MISAO === '1' || process.env.AZITO_EXPERIMENTAL_MISAO === 'true';
}

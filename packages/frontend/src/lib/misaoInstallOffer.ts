import { errorMessageOf } from './apiResult';
import { isMisaoNotInstalled } from './muxKindChoice';

export interface MisaoInstallOfferDeps {
  /** Asks the operator whether misao may be installed on the server. */
  confirm: () => Promise<boolean>;
  /** Installs misao on the server (`POST /servers/:name/install-misao`); resolves with the response body, an error body included. */
  install: () => Promise<unknown>;
}

/**
 * Runs a create call (a window or session in misao). When the hub refuses it because the server has no misao, the operator is
 * asked, misao is installed, and the call runs once more. Everything else is the call's own answer: a declined offer keeps the
 * hub's refusal (shown like any other), a failed install answers with the install's error, and a second refusal is not offered again.
 */
export async function createWithMisaoInstallOffer<T>(create: () => Promise<T>, deps: MisaoInstallOfferDeps): Promise<T | { error: string }> {
  const first = await create();
  if (!isMisaoNotInstalled(first)) return first;
  if (!(await deps.confirm())) return first;
  const failure = errorMessageOf(await deps.install());
  if (failure !== null) return { error: failure };
  return create();
}

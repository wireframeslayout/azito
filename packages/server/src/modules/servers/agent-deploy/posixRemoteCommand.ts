import { shellQuote } from '../../../shared/shellQuote';

/** Run deploy scripts with Bash regardless of the target user's login shell. */
export function posixRemoteCommand(script: string): string {
  return `/bin/bash -c ${shellQuote(script)}`;
}

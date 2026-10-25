export type MisaoServiceErrorCode =
  | 'usage'
  | 'busy'
  /** The misao folder's lock is held by another user's process (or one that cannot be identified): a possible pre-emption, not "try later". */
  | 'lock_foreign'
  | 'not_managed'
  | 'custom_socket'
  /** launchd has the misao job loaded into both gui/<uid> and user/<uid>: which copy is meant is not guessed. */
  | 'duplicate_load'
  | 'not_installed'
  | 'daemon_not_ready'
  | 'update_failed'
  /** An agent server's host cannot take misao (not Linux x86_64, no node-pty, an agent too old to report its host). */
  | 'unsupported_host'
  /** Putting misao on an agent server failed part-way (upload, checksum, preparing the release). */
  | 'transfer_failed';

/** A refusal the caller can show as is: the service operation did not (fully) happen, and why. */
export class MisaoServiceError extends Error {
  constructor(readonly code: MisaoServiceErrorCode, message: string) {
    super(message);
    this.name = 'MisaoServiceError';
  }
}

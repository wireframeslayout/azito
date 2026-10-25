/**
 * What differs between the OSes in `update-run` (updateScript.ts): how the archive is unpacked, how the new version is made the one that
 * runs (a symlink on Unix, `current.txt` on Windows), how the hub is restarted, and what putting the old version back takes. The steps
 * around them (download, verify, state, the order, the rollback decision) are the same everywhere and live in `runUpdate`.
 */
export interface PruneReport {
  /** Version folders that were removed. */
  removed: string[];
  /** Version folders that should go but could not (in use, a file held open): kept, tried again by the next update. */
  failed: Array<{ name: string; reason: string }>;
  /** Version-named entries that were deliberately left alone (a link). */
  skipped: Array<{ name: string; reason: string }>;
}

export interface UpdateBackend {
  /** The file name the downloaded archive is saved as. */
  readonly archiveName: string;
  /** How long the restarted hub gets to answer `/api/health` with the new version. */
  readonly healthTimeoutMs: number;
  /** What the hub runs now, in the form {@link rollback} takes it back (a symlink target, a version tag). */
  currentRef(): string;
  /** Unpacks the archive into `installDir`. An existing `installDir` is the backend's to judge (extract over it, or use it only if it is the same). */
  extract(archive: string, installDir: string): Promise<void>;
  /** Runs `--version` of the unpacked bundle and checks it names `version`. */
  smokeTest(installDir: string, version: string): Promise<void>;
  /** Makes `installDir` the version that runs (nothing is restarted yet). */
  switchTo(installDir: string, version: string): Promise<void>;
  /** Restarts the hub so that it runs what {@link switchTo} chose. */
  restart(): Promise<void>;
  /**
   * Puts `ref` (from {@link currentRef}) back and restarts. `switched`: the run got as far as switching. Unix always restarts (as it always did);
   * Windows leaves a hub that was never switched alone. A backend that cannot put it back says so by throwing.
   */
  rollback(ref: string, switched: boolean): Promise<void>;
  /** Whether `installDir` is what runs now (it is then not removed). */
  isCurrent(installDir: string): boolean;
  /** Removes a folder this run created. Whatever cannot be removed is reported by throwing. */
  removeInstallDir(installDir: string): void;
  /**
   * Optional: tidies the old versions after a SUCCESSFUL update (never after a rollback). `current` is the version just switched to,
   * `previous` what `current.txt` named before. Only the Windows backend has it; the Unix hub keeps its old versions as it always did.
   * A throw is the tidying failing, never the update.
   */
  pruneOldVersions?(versions: { current: string; previous: string }): Promise<PruneReport>;
}

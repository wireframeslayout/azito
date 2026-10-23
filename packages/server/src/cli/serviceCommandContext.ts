/** What `azito service` needs from the process that runs it, resolved at the entry point (`main.ts`). */
export interface ServiceCommandContext {
  env: NodeJS.ProcessEnv;
  /** The release bundle this process runs from, or null for a source checkout. */
  bundleRoot: string | null;
  /** This process's id (the Windows stop must not end the process that runs it). */
  pid: number;
}

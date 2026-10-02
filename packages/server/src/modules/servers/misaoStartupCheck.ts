import type { MuxRuntime } from '@azito/shared';

interface MisaoServerLister {
  listNamesByMuxRuntime(runtime: MuxRuntime): string[];
}

interface ErrorLogger {
  error(msg: string): void;
}

// Startup must not fail for servers the flag-off hub cannot drive; it only reports them so the operator can recover.
export function reportMisaoServersWhenDisabled(repo: MisaoServerLister, misaoEnabled: boolean, logger: ErrorLogger): string[] {
  if (misaoEnabled) return [];
  const names = repo.listNamesByMuxRuntime('misao');
  for (const name of names) {
    logger.error(
      `Server "${name}" uses mux_runtime 'misao' but AZITO_EXPERIMENTAL_MISAO is not enabled; it is unavailable until the hub is started with AZITO_EXPERIMENTAL_MISAO=1 or its runtime is set back to 'system' in the server settings.`,
    );
  }
  return names;
}

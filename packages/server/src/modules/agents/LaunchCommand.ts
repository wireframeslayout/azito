import { defaultRegistry } from './registry';

export { shellQuote } from '../../shared/shellQuote';

/**
 * ヘッドレス(subagent)実行コマンドを組み立てる。
 * provider がレジストリに存在しない、または非対応(generic 等)の場合は null。
 */
export function buildHeadlessLaunchCommand(provider: string, model: string): string | null {
  const p = defaultRegistry.tryGet(provider);
  return p ? p.buildHeadlessCommand(model) : null;
}

/**
 * tmux ペインでの対話起動コマンドを組み立てる。
 * workerType がレジストリに存在しない(generic/未登録カスタムツール/null)場合は、
 * extraArgs をコマンドそのものとして扱う(既存の互換動作)。
 */
export function buildWorkerLaunchCommand(
  workerType: string | null,
  workerModel: string | null,
  extraArgs: string | null,
): string | null {
  const provider = workerType ? defaultRegistry.tryGet(workerType) : null;
  if (provider) {
    return provider.buildLaunchCommand({ model: workerModel, extraArgs });
  }
  return extraArgs?.trim() || null;
}

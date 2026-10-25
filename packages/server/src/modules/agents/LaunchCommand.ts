import { defaultRegistry } from './registry';
import type { ShellDialect } from '../../shared/os/shellDialect';
import { commandLineLaunch, renderLaunchLine, type WorkerLaunch } from './WorkerLaunch';

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
 * ペインでの対話起動を組み立てる（タスクワーカー用: MCP 遮断あり）。POSIX は {@link renderLaunchLine} で行にして打ち込み、
 * Windows は {@link launchArgv} でプログラムと引数にして misao の `pane.open` に渡す。
 * workerType がレジストリに存在しない(generic/未登録カスタムツール/null)場合は、
 * extraArgs をコマンドそのものとして扱う(既存の互換動作)。
 */
export function buildWorkerLaunch(
  workerType: string | null,
  workerModel: string | null,
  extraArgs: string | null,
): WorkerLaunch | null {
  const provider = workerType ? defaultRegistry.tryGet(workerType) : null;
  if (provider) {
    return provider.buildLaunch({ model: workerModel, extraArgs });
  }
  const line = extraArgs?.trim();
  return line ? commandLineLaunch(line) : null;
}

/** {@link buildWorkerLaunch} as the line of `dialect`'s shell (what a window row shows as its launch command). */
export function buildWorkerLaunchCommand(
  workerType: string | null,
  workerModel: string | null,
  extraArgs: string | null,
  dialect: ShellDialect,
): string | null {
  const launch = buildWorkerLaunch(workerType, workerModel, extraArgs);
  return launch ? renderLaunchLine(launch, dialect) : null;
}



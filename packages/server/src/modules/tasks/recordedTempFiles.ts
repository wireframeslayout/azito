import * as path from 'path';
import type { ExecutionLog } from './ExecutionLog';
import { TaskTempFiles } from '../../shared/os/taskTempFiles';

/** execution_log の command ログのうち、タスクの一時ファイルの実際のパスを記録しているもの（type）と、そのキー。 */
const RECORDING_LOGS: Record<string, readonly string[]> = {
  phase_prompt: ['outputFilePath', 'signalFilePath', 'rulesFilePath'],
  follow_up_prompt: ['outputFilePath', 'signalFilePath'],
  wait_start_pipe: ['filePath', 'signalFilePath'],
};

/**
 * タスクの execution_log に記録された、一時ファイルの実際のパス。片付けは配置規則の推測より先にこれを使う
 * （ハブの一時フォルダが変わっても、作った場所のファイルを消せる）。このタスクのファイル名の接頭辞に合わない値は
 * 記録の破損として無視する（片付けで他のファイルを消さないため）。
 */
export function recordedTempFilePaths(logs: readonly ExecutionLog[], taskId: number): string[] {
  const prefixes = TaskTempFiles.prefixesForTask(taskId);
  const found = new Set<string>();
  for (const log of logs) {
    if (log.type !== 'command') continue;
    const record = parseRecord(log.content);
    const keys = record && typeof record.type === 'string' ? RECORDING_LOGS[record.type] : undefined;
    if (!record || !keys) continue;
    for (const key of keys) {
      const value = record[key];
      if (typeof value !== 'string' || !path.isAbsolute(value)) continue;
      if (prefixes.some((p) => path.basename(value).startsWith(p))) found.add(value);
    }
  }
  return [...found];
}

function parseRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

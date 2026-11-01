import { stripTerminalControlSequences } from '../../shared/utils/stripTerminalArtifacts';

export function snapshotScreenText(content: string, lines: number): string {
  const rows = stripTerminalControlSequences(content).replace(/\r\n/g, '\n').split('\n');
  while (rows.length && rows[rows.length - 1].trim() === '') rows.pop();
  return rows.slice(-lines).join('\n');
}

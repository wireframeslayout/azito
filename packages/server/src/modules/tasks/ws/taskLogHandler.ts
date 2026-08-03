import type { WebSocket } from 'ws';
import type { ExecuteTaskUseCase } from '../execution/ExecuteTaskUseCase';
import type { IExecutionLogRepository } from '../ExecutionLog';

export function handleTaskLogStream(
  ws: WebSocket,
  taskId: number,
  executeTaskUseCase: ExecuteTaskUseCase,
  logRepo: IExecutionLogRepository,
): void {
  // Send existing logs first
  const existingLogs = logRepo.findByTask(taskId);
  ws.send(JSON.stringify({ type: 'init', logs: existingLogs }));

  // Listen for new logs
  const onLog = (log: any) => {
    if (log.taskId === taskId && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'log', log }));
    }
  };

  executeTaskUseCase.events.on('log', onLog);
  ws.on('close', () => executeTaskUseCase.events.off('log', onLog));
}

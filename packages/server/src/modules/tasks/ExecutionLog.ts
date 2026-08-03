export type LogType = 'llm_request' | 'llm_response' | 'command' | 'output' | 'status_change' | 'user_comment';

export interface ExecutionLog {
  id: number;
  taskId: number | null;
  unitId: number;
  type: LogType;
  content: string;
  createdAt: string;
}

export interface IExecutionLogRepository {
  append(taskId: number | null, unitId: number, type: LogType, content: unknown): void;
  findByTask(taskId: number): ExecutionLog[];
  findByUnit(unitId: number, limit?: number): ExecutionLog[];
}

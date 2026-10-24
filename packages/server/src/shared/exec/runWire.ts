import { z } from 'zod';
import {
  CommandOutputLimitError,
  CommandSpawnError,
  GIT_NOT_FOUND_CODE,
  GitNotFoundError,
  CommandTimeoutError,
  type CommandResult,
  type CommandSpec,
} from './commandSpec';
import { runCommandSpec, type RunCommandOptions } from './runCommandSpec';

/** Agent endpoint (behind the agent token) that runs a {@link CommandSpec} on the agent's host. */
export const AGENT_RUN_PATH = '/api/run';

const outputs = { stdout: z.string(), stderr: z.string() };

/** The body of a `POST /api/run` response: how the command ended, failures included (HTTP 200 for all; a bad request is 400). */
const runResponseSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('result'), exitCode: z.number().int(), signal: z.string().nullable(), ...outputs }),
  z.object({ outcome: z.literal('spawn_failed'), code: z.string(), message: z.string(), ...outputs }),
  z.object({ outcome: z.literal('timeout'), timeoutMs: z.number(), ...outputs }),
  z.object({ outcome: z.literal('output_limit'), maxOutputBytes: z.number(), ...outputs }),
]);
export type RunResponse = z.infer<typeof runResponseSchema>;

/** The agent side: runs the spec with the same function the hub uses and reports how it ended. Unexpected errors propagate. */
export async function runToResponse(spec: CommandSpec, options: RunCommandOptions): Promise<RunResponse> {
  try {
    const result = await runCommandSpec(spec, options);
    return { outcome: 'result', ...result };
  } catch (err) {
    if (err instanceof CommandSpawnError) return { outcome: 'spawn_failed', code: err.code, message: err.message, stdout: err.stdout, stderr: err.stderr };
    if (err instanceof CommandTimeoutError) return { outcome: 'timeout', timeoutMs: err.timeoutMs, stdout: err.stdout, stderr: err.stderr };
    if (err instanceof CommandOutputLimitError) return { outcome: 'output_limit', maxOutputBytes: err.maxOutputBytes, stdout: err.stdout, stderr: err.stderr };
    throw err;
  }
}

/** The hub side: the result, or the matching {@link CommandError}. A body of another shape is an error (an agent this hub does not understand). */
export function responseToResult(body: unknown): CommandResult {
  const response = runResponseSchema.parse(body);
  switch (response.outcome) {
    case 'result':
      return { exitCode: response.exitCode, signal: response.signal, stdout: response.stdout, stderr: response.stderr };
    case 'spawn_failed':
      if (response.code === GIT_NOT_FOUND_CODE) throw new GitNotFoundError(response.message, response.stdout, response.stderr);
      throw new CommandSpawnError(response.code, response.message, response.stdout, response.stderr);
    case 'timeout':
      throw new CommandTimeoutError(response.timeoutMs, response.stdout, response.stderr);
    case 'output_limit':
      throw new CommandOutputLimitError(response.maxOutputBytes, response.stdout, response.stderr);
  }
}

import { z } from 'zod';

const nullableString = z.string().nullable().optional();
export const projectWindowBody = z.strictObject({ server_name: z.string().optional(), tmux_target: z.string().optional(), ref: z.string().optional(), worker_type: nullableString, worker_model: nullableString, working_directory: nullableString, agent_session_id: nullableString, label: nullableString, window_type: z.string().optional(), launch_command: nullableString });
export const serverWindowBody = projectWindowBody.extend({ role: z.enum(['orchestrator']).nullable().optional() });
export const projectSessionBody = z.strictObject({ server_name: z.string().optional(), session: z.string().optional(), kind: z.unknown().optional() });
export const taskWindowBody = z.strictObject({ server_name: z.string().optional(), tmux_target: z.string().optional(), ref: z.string().optional(), label: nullableString, window_type: z.string().optional(), worker_type: nullableString, worker_model: nullableString, working_directory: nullableString });
export const updateWindowBody = z.strictObject({ label: nullableString, agent_session_id: nullableString, launch_command: nullableString, worker_model: nullableString, working_directory: nullableString, window_type: z.string().optional(), worker_type: nullableString });
export const launchAgentBody = z.strictObject({ command: z.string().optional(), force: z.boolean().optional() });

export const respawnBody = z.strictObject({ force: z.boolean().optional(), mux: z.enum(['tmux', 'misao']).optional() });

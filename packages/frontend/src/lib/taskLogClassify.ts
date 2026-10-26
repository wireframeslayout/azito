/** Classify a log entry into a visual style bucket */
export function classify(type: string, parsed: any): 'resource-skipped' | 'system' | 'orchestrator' | 'worker-prompt' | 'terminal' | 'done' | 'error' | 'launch' | 'auto-approve' | 'user-comment' | 'session-resumed' | 'warning' | 'info-identity' | null {
  if (type === 'user_comment') return 'user-comment';
  if (type === 'status_change') {
    if (typeof parsed === 'object' && parsed !== null) {
      if (parsed.status === 'done') return 'done';
      if (parsed.status === 'failed') return 'error';
      if (parsed.status === 'session_resumed') return 'session-resumed';
    }
    return 'system';
  }
  if (type === 'llm_request') return 'orchestrator';
  if (type === 'llm_response') {
    if (typeof parsed === 'object' && parsed?.action === 'done') return 'done';
    if (typeof parsed === 'object' && parsed?.action === 'error') return 'error';
    // prompt responses are shown via the subsequent 'command' log entry, skip here
    return 'orchestrator';
  }
  if (type === 'command') {
    if (typeof parsed === 'object' && parsed !== null) {
      if (parsed.type === 'git_identity_missing' || parsed.type === 'git_identity_failed') return 'warning';
      if (parsed.type === 'git_identity_applied') return 'info-identity';
      if (parsed.type === 'wait_poll' || parsed.type === 'wait_start' || parsed.type === 'llm_classify') return null;
      if (parsed.type === 'worker_prompt') return 'worker-prompt';
      if (parsed.type === 'worker_launch') return 'launch';
      if (parsed.type === 'auto_approve') return 'auto-approve';
      if (parsed.type === 'resource_guard_skipped') return 'resource-skipped';
    }
    return 'system';
  }
  if (type === 'output') return 'terminal';
  return 'system';
}

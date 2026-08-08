type PushLang = 'ja' | 'en';

interface PushMessage {
  title: string;
  body: string;
}

const catalog = {
  en: {
    'test':                  { title: 'AZITO: Test Notification',  body: 'Push notifications are working!' },
    'task.done':             { title: 'AZITO: Task Completed',     body: 'Task "{{taskTitle}}" completed successfully' },
    'task.error':            { title: 'AZITO: Task Failed',        body: 'Task "{{taskTitle}}" failed' },
    'task.stoppedByUser':    { title: 'AZITO: Task Stopped',       body: 'Task "{{taskTitle}}" was stopped' },
    'task.sendError':        { title: 'AZITO: Task Failed',        body: 'Task "{{taskTitle}}" failed (send error)' },
    'task.codexError':       { title: 'AZITO: Task Failed',        body: 'Task "{{taskTitle}}" failed (codex error)' },
    'task.waitingForHuman':  { title: 'AZITO: Questions',          body: 'Task "{{taskTitle}}" has questions that need your input' },
    'task.phaseReview':      { title: 'AZITO: Plan Review',        body: 'Task "{{taskTitle}}" plan is ready for review' },
    'task.pendingApproval':  { title: 'AZITO: Approval Required',  body: 'Task "{{taskTitle}}" is blocked pending your approval to run' },
    'agent.finished':        { title: 'AZITO: Agent Finished',     body: '{{label}} on {{serverName}} finished' },
    'agent.approvalRequired':{ title: 'AZITO: Approval Required',  body: '{{label}} on {{serverName}} needs approval' },
    'agent.idle':            { title: 'AZITO: Agent Idle',         body: '{{label}} became idle on {{serverName}}' },
  },
  ja: {
    'test':                  { title: 'AZITO: テスト通知',          body: 'プッシュ通知は正常に動作しています' },
    'task.done':             { title: 'AZITO: タスク完了',          body: 'タスク「{{taskTitle}}」が正常に完了しました' },
    'task.error':            { title: 'AZITO: タスク失敗',          body: 'タスク「{{taskTitle}}」が失敗しました' },
    'task.stoppedByUser':    { title: 'AZITO: タスク停止',          body: 'タスク「{{taskTitle}}」が停止されました' },
    'task.sendError':        { title: 'AZITO: タスク失敗',          body: 'タスク「{{taskTitle}}」が失敗しました（送信エラー）' },
    'task.codexError':       { title: 'AZITO: タスク失敗',          body: 'タスク「{{taskTitle}}」が失敗しました（codexエラー）' },
    'task.waitingForHuman':  { title: 'AZITO: 質問あり',            body: 'タスク「{{taskTitle}}」に回答が必要な質問があります' },
    'task.phaseReview':      { title: 'AZITO: 計画レビュー',        body: 'タスク「{{taskTitle}}」の計画がレビュー待ちです' },
    'task.pendingApproval':  { title: 'AZITO: 承認が必要',          body: 'タスク「{{taskTitle}}」が実行の承認待ちで停止しています' },
    'agent.finished':        { title: 'AZITO: エージェント完了',    body: '{{label}}（{{serverName}}）が完了しました' },
    'agent.approvalRequired':{ title: 'AZITO: 承認が必要',          body: '{{label}}（{{serverName}}）が承認を待っています' },
    'agent.idle':            { title: 'AZITO: エージェント待機',    body: '{{label}}が{{serverName}}上で待機状態になりました' },
  },
} as const;

export type PushMessageKey = keyof typeof catalog.en;

function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? '');
}

export function getPushMessage(
  lang: string,
  key: PushMessageKey,
  params: Record<string, string> = {},
): PushMessage {
  const resolvedLang: PushLang = lang === 'ja' ? 'ja' : 'en';
  const entry = catalog[resolvedLang][key];
  return {
    title: interpolate(entry.title, params),
    body: interpolate(entry.body, params),
  };
}

export const version = 19;
export const description = 'Include plan markdown in implementing phase prompt';

export function up(db: import('better-sqlite3').Database): void {
  const row = db.prepare("SELECT prompt FROM phase_prompts WHERE phase = 'implementing'").get() as { prompt: string } | undefined;
  if (!row) return;

  const updated = row.prompt.replace(
    '<task>\nImplement according to the plan.\nTitle: {{task.title}}\nWorking directory: {{projectServer.workingDirectory}}\n</task>',
    '<task>\nImplement according to the plan.\nTitle: {{task.title}}\nWorking directory: {{projectServer.workingDirectory}}\n\n<plan>\n{{task.plan}}\n</plan>\n</task>',
  );

  if (updated !== row.prompt) {
    db.prepare("UPDATE phase_prompts SET prompt = ? WHERE phase = 'implementing'").run(updated);
  }
}

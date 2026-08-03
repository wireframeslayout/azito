export const version = 18;
export const description = 'Update phase prompts to use QUESTIONS_JSON structured output';

export function up(db: import('better-sqlite3').Database): void {
  const questionsInstruction = `If you have questions that need human input, output them as structured JSON on a single line:
QUESTIONS_JSON: [{"text":"question text","type":"select","options":["option1","option2"]},{"text":"open question","type":"text"}]
- Use "select" type when you can enumerate the choices, and "text" type for open-ended questions.
- Output ALL questions at once in a single QUESTIONS_JSON line.
- Do NOT use interactive prompts or selection UIs. Output QUESTIONS_JSON and then stop.`;

  const phases = db.prepare('SELECT phase, prompt FROM phase_prompts WHERE enabled = 1').all() as Array<{ phase: string; prompt: string }>;

  const update = db.prepare('UPDATE phase_prompts SET prompt = ? WHERE phase = ?');

  for (const { phase, prompt } of phases) {
    const updated = prompt.replace(
      /If you have questions that need human input, report them prefixed with "QUESTION:"\./g,
      questionsInstruction,
    );
    if (updated !== prompt) {
      update.run(updated, phase);
    }
  }
}

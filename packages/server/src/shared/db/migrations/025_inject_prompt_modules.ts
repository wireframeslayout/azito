import type { Database } from 'better-sqlite3';

export const version = 25;
export const description = 'Append prompt module variables to phase_prompts templates';

export function up(db: Database): void {
  const getPrompt = db.prepare("SELECT prompt FROM phase_prompts WHERE phase = ?");
  const setPrompt = db.prepare("UPDATE phase_prompts SET prompt = ?, updated_at = datetime('now') WHERE phase = ?");

  // planning: append softwareDesignPrinciples and uiDesignPrinciples
  const planningRow = getPrompt.get('planning') as { prompt: string } | undefined;
  if (planningRow && !planningRow.prompt.includes('{{module.')) {
    setPrompt.run(
      planningRow.prompt + '\n\n{{module.softwareDesignPrinciples}}\n\n{{module.uiDesignPrinciples}}',
      'planning',
    );
  }

  // implementing: append uiDesignPrinciples and softwareDesignPrinciples
  const implementingRow = getPrompt.get('implementing') as { prompt: string } | undefined;
  if (implementingRow && !implementingRow.prompt.includes('{{module.')) {
    setPrompt.run(
      implementingRow.prompt + '\n\n{{module.uiDesignPrinciples}}\n\n{{module.softwareDesignPrinciples}}',
      'implementing',
    );
  }

  // reviewing: append reviewPerspectives
  const reviewingRow = getPrompt.get('reviewing') as { prompt: string } | undefined;
  if (reviewingRow && !reviewingRow.prompt.includes('{{module.')) {
    setPrompt.run(
      reviewingRow.prompt + '\n\n{{module.reviewPerspectives}}',
      'reviewing',
    );
  }
}

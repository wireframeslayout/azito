import type { IContentExtractor, ExtractPlanResult, ExtractQuestionsResult } from './ContentExtractor';
import type { PaneQuestion } from './PaneClassifier';
import type { ILlmClient } from './ILlmClient';

export class LlmContentExtractor implements IContentExtractor {
  constructor(private llmClient: ILlmClient) {}

  async extractPlan(paneText: string): Promise<ExtractPlanResult> {
    const stripped = paneText.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const tail = stripped.split('\n').slice(-500).join('\n');

    const prompt = `You are a markdown extractor. The following is terminal output from a coding agent that was asked to create an implementation plan.

<terminal_output>
${tail}
</terminal_output>

Extract the implementation plan as clean markdown. The plan typically starts with "## 実装計画" or "実装計画" and includes sections like 要件, 変更ファイル, 実装ステップ, 影響範囲, 設計判断, リスク.

Rules:
- Extract ONLY the plan content — no terminal UI elements (prompt lines, status bars, separators)
- Preserve the original markdown structure (headers, lists, tables)
- If no plan is found, return null
- Do NOT add or modify content — extract verbatim

Respond with ONLY a JSON object (no markdown fences, no explanation):
{"planMarkdown": "## 実装計画\\n\\n### 要件\\n- ..."}

If no plan found:
{"planMarkdown": null}`;

    try {
      const raw = await this.llmClient.exec(prompt);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { planMarkdown: null };
      const parsed = JSON.parse(jsonMatch[0]) as ExtractPlanResult;
      return { planMarkdown: parsed.planMarkdown || null };
    } catch {
      return { planMarkdown: null };
    }
  }

  async extractQuestions(paneText: string): Promise<ExtractQuestionsResult> {
    const stripped = paneText.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const tail = stripped.split('\n').slice(-200).join('\n');

    const prompt = `You are a question extractor. The following is terminal output from a coding agent that is asking the user questions.

<terminal_output>
${tail}
</terminal_output>

Extract all questions the agent is asking. Each question should be classified as "select" (with predefined options) or "text" (open-ended).

Rules:
- Extract the full question text
- For "select" type, list all available options
- Ignore template/example questions (e.g., "question text", "open question")
- Ignore terminal UI decorations

Respond with ONLY a JSON object (no markdown fences, no explanation):
{"questions": [{"text": "質問内容", "type": "select", "options": ["A", "B", "C"]}, {"text": "自由回答の質問", "type": "text"}]}

If no questions found:
{"questions": []}`;

    try {
      const raw = await this.llmClient.exec(prompt);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { questions: [] };
      const parsed = JSON.parse(jsonMatch[0]) as { questions: PaneQuestion[] };
      return { questions: Array.isArray(parsed.questions) ? parsed.questions : [] };
    } catch {
      return { questions: [] };
    }
  }

  async generateSlug(title: string): Promise<string> {
    const prompt = `Convert the following task title into a short English slug for a git branch name.

Title: ${title}

Rules:
- Output ONLY the slug, nothing else
- Use lowercase alphanumeric characters and hyphens only
- Maximum 30 characters
- Translate non-English text to English first, then slugify
- Example: "Taskページの改修" → "task-page-redesign"
- Example: "カンバン表示の追加" → "add-kanban-view"`;

    try {
      const raw = await this.llmClient.exec(prompt);
      const slug = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
      return slug || 'task';
    } catch {
      return 'task';
    }
  }
}

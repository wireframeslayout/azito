import type { PaneQuestion } from './PaneClassifier';

export interface ExtractPlanResult {
  planMarkdown: string | null;
}

export interface ExtractQuestionsResult {
  questions: PaneQuestion[];
}

export interface IContentExtractor {
  extractPlan(paneText: string): Promise<ExtractPlanResult>;
  extractQuestions(paneText: string): Promise<ExtractQuestionsResult>;
  generateSlug(title: string): Promise<string>;
}

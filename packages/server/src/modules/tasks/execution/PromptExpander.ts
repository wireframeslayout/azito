import { expandPromptTemplate } from '../../prompt/promptTemplate';

// ─── Prompt / text formatting helpers ───
//
// Pure functions extracted from ExecuteTaskUseCase. No shared instance state —
// all inputs are passed explicitly as arguments.

export function expandTemplate(template: string, vars: Record<string, Record<string, string>>, keepUnknown = false): string {
  return expandPromptTemplate(template, vars, keepUnknown);
}

export function removeCompletionSignalBlock(text: string): string {
  // Remove <completion_signal>...</completion_signal> blocks
  return text.replace(/<completion_signal>[\s\S]*?<\/completion_signal>/g, '');
}

export function extractPlanMarkdown(output: string): string | null {
  const stripped = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

  const templatePlaceholder = '(list each requirement derived from the task)';
  const marker = '実装計画';

  // Prefer markdown heading form (## 実装計画, etc.) — pick the last occurrence
  let bestIdx = -1;
  const headingRe = /^#{1,4}\s*実装計画/gm;
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = headingRe.exec(stripped)) !== null) {
    const afterMarker = stripped.slice(headingMatch.index, headingMatch.index + 200);
    if (!afterMarker.includes(templatePlaceholder)) {
      bestIdx = headingMatch.index;
    }
  }

  // Fallback: plain '実装計画' text search if no heading found
  if (bestIdx < 0) {
    let searchFrom = 0;
    while (true) {
      const idx = stripped.indexOf(marker, searchFrom);
      if (idx < 0) break;
      const afterMarker = stripped.slice(idx, idx + 200);
      if (!afterMarker.includes(templatePlaceholder)) {
        bestIdx = idx;
      }
      searchFrom = idx + marker.length;
    }
  }

  if (bestIdx < 0) return null;

  let plan = stripped.slice(bestIdx);

  // Cut at the earliest of: PHASE_COMPLETE, <completion_signal>, AZITO_DONE_
  const cutCandidates: number[] = [];
  const phaseCompleteIdx = plan.search(/PHASE_COMPLETE/i);
  if (phaseCompleteIdx > 0) cutCandidates.push(phaseCompleteIdx);
  const completionSignalIdx = plan.indexOf('<completion_signal>');
  if (completionSignalIdx > 0) cutCandidates.push(completionSignalIdx);
  const azitoDoneIdx = plan.indexOf('AZITO_DONE_');
  if (azitoDoneIdx > 0) cutCandidates.push(azitoDoneIdx);
  if (cutCandidates.length > 0) {
    plan = plan.slice(0, Math.min(...cutCandidates));
  }

  return plan.trim() || null;
}


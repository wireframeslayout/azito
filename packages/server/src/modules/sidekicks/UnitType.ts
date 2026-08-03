export type SubagentRole = 'implement' | 'review';

export interface UnitTypePhase {
  name: string;
  label: string;
  tags: string[];
  questions: boolean;
  testFailed: boolean;
  planApproval: boolean;
  selfReviewRetry: boolean;
  testFailedRollbackTo?: string;
  pushVerify: boolean;
  subagentRole?: SubagentRole;
  skillCommand?: string;
  defaultSidekick?: string;
}

export interface UnitType {
  name: string;
  label: string;
  description?: string;
  phases: UnitTypePhase[];
}

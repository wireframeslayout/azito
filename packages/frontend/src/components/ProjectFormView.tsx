import ProjectWizard from './ProjectWizard';

interface ProjectFormViewProps {
  onSaved: (projectId?: number) => void;
  onCancel: () => void;
  backLabel?: string;
  onBack?: () => void;
}

/**
 * Thin wrapper around the shared wizard body (ProjectWizard.tsx) — kept as
 * its own component/file because GlobalPageShell.tsx already imports it by
 * this name for the `/projects/new` route, and its props (onSaved/onCancel/
 * backLabel/onBack) are the route's existing public contract.
 */
export default function ProjectFormView({ onSaved, onCancel, backLabel, onBack }: ProjectFormViewProps) {
  return (
    <ProjectWizard
      mode="create"
      onDone={(projectId) => onSaved(projectId)}
      onCancel={onCancel}
      backLabel={backLabel}
      onBack={onBack}
    />
  );
}

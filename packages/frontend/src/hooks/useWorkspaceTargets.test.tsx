import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkspaceTargetsProvider, useWorkspaceTargets } from './useWorkspaceTargets';

function FocusControls() {
  const { focusedTarget, focusedTargetDisplay, setFocusedTarget } = useWorkspaceTargets();
  return <>
    <button onClick={() => setFocusedTarget('wid:42', { serverName: 'remote', label: 'session:1' })}>Focus</button>
    <button onClick={() => setFocusedTarget(null)}>Clear</button>
    <output>{JSON.stringify({ focusedTarget, focusedTargetDisplay })}</output>
  </>;
}

describe('workspace focus', () => {
  it('keeps the matching key separate from display information and clears both', () => {
    render(<WorkspaceTargetsProvider><FocusControls /></WorkspaceTargetsProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(screen.getByRole('status').textContent).toContain('"serverName":"remote"');
    expect(screen.getByRole('status').textContent).toContain('"focusedTarget":"wid:42"');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('status').textContent).toBe('{"focusedTarget":null,"focusedTargetDisplay":null}');
  });
});

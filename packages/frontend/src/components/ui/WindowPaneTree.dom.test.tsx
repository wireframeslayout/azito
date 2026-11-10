import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WindowPaneTree, type WindowItem } from './WindowPaneTree';
import TaskWindowDropdown from '../task/TaskWindowDropdown';
import type { Pane, Session } from '../../pages/workspace/types';

vi.mock('../../hooks/useAgentActivity', () => ({ useAgentActivity: () => ({ windowIndicator: () => null, findFinished: () => undefined }) }));
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));

const windowItem: WindowItem = { id: 42, serverName: 'local', tmuxTarget: 'dev:editor', label: 'Registered', labelSource: 'auto' };
const pane = (title: string, command = 'bash', index = 1): Pane => ({ index, title, command, width: 80, height: 24, active: index === 1 });

function renderTree(item: WindowItem, panes: Pane[], renderSubtitle?: (w: WindowItem) => React.ReactNode, showNameSubtitle = true) {
  const sessions: Session[] = [{ name: 'dev', windows: [{ index: 1, name: 'editor', ref: '', windowId: 42, panes }] }];
  return render(<WindowPaneTree windows={[item]} sessionData={{ local: sessions }} onPaneClick={vi.fn()} renderSubtitle={renderSubtitle} showNameSubtitle={showNameSubtitle} />);
}

function expectLines(title: string, subtitle?: string) {
  const titleElement = screen.getByText(title);
  const content = titleElement.parentElement!.parentElement!;
  expect(content.children[0].contains(titleElement)).toBe(true);
  if (subtitle === undefined) expect(content.children).toHaveLength(1);
  else expect(content.children[1].textContent).toBe(subtitle);
}

describe('WindowPaneTree single pane title', () => {
  it.each([
    ['auto', 'Working', 'bash', 'Working', 'Registered'],
    ['user', 'Working', 'bash', 'Registered', 'Working'],
    ['auto', '', 'bash', 'Registered', 'bash'],
    ['user', '', 'bash', 'Registered', 'bash'],
    ['auto', 'bash', 'bash', 'Registered', 'bash'],
    ['user', 'Registered', 'bash', 'Registered', undefined],
    ['auto', 'Registered', 'bash', 'Registered', undefined],
    ['auto', '', '', 'Registered', ''],
  ] as const)('%s title %s and command %s', (labelSource, title, command, expectedTitle, expectedSubtitle) => {
    renderTree({ ...windowItem, labelSource }, [pane(title, command)]);
    expectLines(expectedTitle, expectedSubtitle);
  });

  it.each(['Task subtitle', null, undefined])('preserves the subtitle callback result %s', (result) => {
    renderTree(windowItem, [pane('Working')], () => result);
    expectLines('Working', result ?? undefined);
    expect(screen.queryByText('Registered')).toBeNull();
  });

  it('suppresses a subtitle callback equal to the title', () => {
    renderTree(windowItem, [pane('Working')], () => 'Working');
    expectLines('Working');
  });

  it('keeps the task dropdown default subtitle', () => {
    const sessions: Session[] = [{ name: 'dev', windows: [{ index: 1, name: 'editor', ref: '', windowId: 42, panes: [pane('Working')] }] }];
    render(<TaskWindowDropdown windows={[windowItem]} sessionData={{ local: sessions }} activeTarget={null} onPaneClick={vi.fn()} onClose={vi.fn()} />);
    expectLines('Working');
    expect(screen.queryByText('Registered')).toBeNull();
  });

  it.each([{ workerType: 'claude' }, { windowType: 'terminal' }])('keeps the command when a type is present: %o', (type) => {
    renderTree({ ...windowItem, labelSource: 'user', ...type }, [pane('', 'bash')]);
    expectLines('Registered', 'bash');
  });

  it('keeps multiple pane parent and children unchanged', () => {
    renderTree(windowItem, [pane('Working'), pane('Other', 'zsh', 2)]);
    expectLines('Working');
    expect(screen.queryByText('Registered')).toBeNull();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getAllByText('Working')).toHaveLength(2);
    expect(screen.getByText('Other')).toBeTruthy();
  });
});

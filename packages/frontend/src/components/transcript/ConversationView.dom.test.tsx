import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ConversationView from './ConversationView';

vi.mock('../../api/client', () => ({ apiWithStatus: () => new Promise(() => {}) }));
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('./PromptInputBar', () => ({ default: ({ readOnlyReason, relay }: { readOnlyReason?: string; relay?: unknown }) => <div data-testid="input">{readOnlyReason ?? (relay ? 'relay' : 'parent input')}</div> }));

describe('child conversation input', () => {
  it('defaults to read-only when relay information is absent', () => {
    render(<ConversationView windowId={1} sessionId="parent" agentType="claude" paneId="%1" agentDetected subagentId="child" />);
    expect(screen.getByTestId('input')).toHaveTextContent('subagents.unavailable');
  });
  it('explains that an outdated agent needs an update for relay', () => {
    render(<ConversationView windowId={1} sessionId="parent" agentType="claude" paneId="%1" agentDetected subagentId="child" subagentRelay={{ kind: 'unavailable', reason: 'agent_outdated' }} />);
    expect(screen.getByTestId('input')).toHaveTextContent('subagents.errors.agent_outdated');
  });
  it('uses the existing unavailable message when the child is missing', () => {
    render(<ConversationView windowId={1} sessionId="parent" agentType="claude" paneId="%1" agentDetected subagentId="child" subagentRelay={{ kind: 'unavailable', reason: 'unavailable' }} />);
    expect(screen.getByTestId('input')).toHaveTextContent('subagents.unavailable');
  });
  it('explains why an unnamed child cannot receive a relay', () => {
    render(<ConversationView windowId={1} sessionId="parent" agentType="claude" paneId="%1" agentDetected subagentId="child" subagentRelay={{ kind: 'unavailable', reason: 'unnamed' }} />);
    expect(screen.getByTestId('input')).toHaveTextContent('subagents.relayUnavailable.unnamed');
  });
});

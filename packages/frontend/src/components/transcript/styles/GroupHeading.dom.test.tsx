import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { GroupHeading } from './GroupHeading';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

it('omits unavailable metadata and shows available model and time', () => {
  const view = render(<GroupHeading isUser={false} agentLabel="CLAUDE" timeLabel="" />);
  expect(view.container.textContent).toBe('CLAUDE');
  view.rerender(<GroupHeading isUser={false} agentLabel="CLAUDE" model="model-name" timeLabel="12:34" />);
  expect(screen.getByText('· model-name')).toBeInTheDocument();
  expect(screen.getByText('12:34')).toBeInTheDocument();
});

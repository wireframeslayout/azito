import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TaskFormFields from './TaskFormFields';
import { emptyTaskForm } from '../lib/taskForm';

vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key === 'units:windowFallback' ? 'Window' : key }) }));

describe('TaskFormFields window input', () => {
  it('hides a stored misao ID without changing it until the field is edited', () => {
    const onChange = vi.fn();
    const value = emptyTaskForm({ tmuxWindow: 'dev:w_01234567890123456789012345' });
    render(<TaskFormFields value={value} onChange={onChange} mode="edit" units={[]} />);
    const input = screen.getByPlaceholderText('Window') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'editor' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tmuxWindow: 'editor' }));
  });

  it('retains a tmux window value', () => {
    render(<TaskFormFields value={emptyTaskForm({ tmuxWindow: 'dev:editor' })} onChange={vi.fn()} mode="edit" units={[]} />);
    expect((screen.getByDisplayValue('dev:editor') as HTMLInputElement).value).toBe('dev:editor');
  });
});

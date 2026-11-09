// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { BinaryFilesBackend } from '../files/backend/FilesBackend';
import { CsvTableEditor } from './CsvTableEditor';
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it('edits a cell and saves the edited UTF-8 bytes', async () => {
  const saveBinary = vi.fn(async (_path: string, _bytes: Uint8Array) => ({ kind: 'saved' as const, version: 'v2' }));
  const backend = { source: 'test', readBinary: async () => ({ bytes: new TextEncoder().encode('a,b\r\nc,d'), version: 'v1' }), saveBinary } as unknown as BinaryFilesBackend;
  render(<CsvTableEditor backend={backend} path="a.csv" />);
  const input = await screen.findByLabelText('1, 1');
  fireEvent.change(input, { target: { value: 'updated' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'office.save' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'office.save' }));
  await waitFor(() => expect(saveBinary).toHaveBeenCalled());
  expect(new TextDecoder().decode(saveBinary.mock.calls[0][1])).toBe('updated,b\r\nc,d');
});

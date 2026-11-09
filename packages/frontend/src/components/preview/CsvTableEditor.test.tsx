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
  expect(screen.getByRole('grid')).toBeInTheDocument();
  input.focus();
  fireEvent.keyDown(input, { key: 'ArrowRight' });
  expect(screen.getByLabelText('1, 2')).toHaveFocus();
  fireEvent.change(input, { target: { value: 'updated' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'office.save' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'office.save' }));
  await waitFor(() => expect(saveBinary).toHaveBeenCalled());
  expect(new TextDecoder().decode(saveBinary.mock.calls[0][1])).toBe('updated,b\r\nc,d');
});

it('converts the current cells when changing delimiter, retaining pending edits and BOM', async () => {
  const saveBinary = vi.fn(async (_path: string, _bytes: Uint8Array) => ({ kind: 'saved' as const, version: 'v2' }));
  const backend = { source: 'test', readBinary: async () => ({ bytes: new TextEncoder().encode('\ufeff"a,b",c\r\nd,e'), version: 'v1' }), saveBinary } as unknown as BinaryFilesBackend;
  render(<CsvTableEditor backend={backend} path="a.csv" />);
  fireEvent.change(await screen.findByLabelText('1, 2'), { target: { value: 'changed' } });
  await waitFor(() => expect(screen.getByLabelText('office.delimiter')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('office.delimiter'), { target: { value: ';' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'office.save' })).toBeEnabled());
  expect(screen.getByLabelText('1, 1')).toHaveValue('a,b');
  expect(screen.getByLabelText('1, 2')).toHaveValue('changed');
  fireEvent.click(screen.getByRole('button', { name: 'office.save' }));
  await waitFor(() => expect(saveBinary).toHaveBeenCalled());
  expect(Array.from(saveBinary.mock.calls[0][1])).toEqual(Array.from(new TextEncoder().encode('\ufeffa,b;changed\r\nd;e')));
});

it('marks a delimiter-only conversion dirty and saves it', async () => {
  const saveBinary = vi.fn(async (_path: string, _bytes: Uint8Array) => ({ kind: 'saved' as const, version: 'v2' }));
  const backend = { source: 'test', readBinary: async () => ({ bytes: new TextEncoder().encode('a,b\nc,d'), version: 'v1' }), saveBinary } as unknown as BinaryFilesBackend;
  render(<CsvTableEditor backend={backend} path="a.csv" />);
  fireEvent.change(await screen.findByLabelText('office.delimiter'), { target: { value: '\t' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'office.save' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'office.save' }));
  await waitFor(() => expect(saveBinary).toHaveBeenCalled());
  expect(new TextDecoder().decode(saveBinary.mock.calls[0][1])).toBe('a\tb\nc\td');
});

it('disables delimiter conversion and saving when the preview is truncated', async () => {
  const backend = { source: 'test', readBinary: async () => ({ bytes: new TextEncoder().encode(Array.from({ length: 101 }, () => 'x').join(',')), version: 'v1' }), saveBinary: vi.fn() } as unknown as BinaryFilesBackend;
  render(<CsvTableEditor backend={backend} path="a.csv" />);
  expect(await screen.findByLabelText('office.delimiter')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'office.save' })).toBeDisabled();
});

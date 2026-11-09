// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FilePreviewPanel } from './FilePreviewPanel';

vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('./useFileDownload', () => ({ useFileDownload: () => vi.fn() }));
vi.mock('./TextFileEditor', () => ({ TextFileEditor: () => <div>text editor</div> }));
vi.mock('../preview/PreviewSwitch', () => ({ PreviewSwitch: () => <div>table preview</div> }));
afterEach(cleanup);

it('keeps CSV readable as text without a project, and uses the table when a project exists', () => {
  const { rerender } = render(<FilePreviewPanel serverName="local" filePath="/tmp/data.csv" />);
  expect(screen.getByText('text editor')).toBeInTheDocument();
  rerender(<FilePreviewPanel serverName="local" filePath="/tmp/data.csv" projectId={1} />);
  expect(screen.getByText('table preview')).toBeInTheDocument();
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { BinaryFilesBackend } from '../files/backend/FilesBackend';
import { MediaView } from './MediaView';
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('renews an expired media URL and restores its position', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const mediaUrl = vi.fn().mockResolvedValueOnce('/api/media/one').mockResolvedValueOnce('/api/media/two');
  const backend = { mediaUrl } as unknown as BinaryFilesBackend;
  const { container } = render(<MediaView backend={backend} path="a.mp4" type="video" />);
  await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
  const video = container.querySelector('video')!;
  video.currentTime = 14;
  fireEvent.timeUpdate(video);
  now += 600_000;
  fireEvent.error(video);
  await waitFor(() => expect(mediaUrl).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(video.getAttribute('src')).toBe('/api/media/two'));
  video.currentTime = 0;
  fireEvent.timeUpdate(video);
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(14);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('ignores a delayed renewal after switching files', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  let finishRenewal!: (url: string) => void;
  const delayed = new Promise<string>((resolve) => { finishRenewal = resolve; });
  const mediaUrl = vi.fn().mockResolvedValueOnce('/api/media/one').mockReturnValueOnce(delayed).mockResolvedValueOnce('/api/media/new');
  const backend = { mediaUrl } as unknown as BinaryFilesBackend;
  const { container, rerender } = render(<MediaView backend={backend} path="a.mp4" type="video" />);
  await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
  now += 600_000;
  fireEvent.error(container.querySelector('video')!);
  await waitFor(() => expect(mediaUrl).toHaveBeenCalledTimes(2));
  rerender(<MediaView backend={backend} path="b.mp4" type="video" />);
  await waitFor(() => expect(container.querySelector('video')?.getAttribute('src')).toBe('/api/media/new'));
  await act(async () => { finishRenewal('/api/media/stale'); await delayed; });
  expect(container.querySelector('video')?.getAttribute('src')).toBe('/api/media/new');
});

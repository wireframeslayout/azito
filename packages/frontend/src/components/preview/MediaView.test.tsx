// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(14);
  expect(screen.queryByRole('alert')).toBeNull();
});

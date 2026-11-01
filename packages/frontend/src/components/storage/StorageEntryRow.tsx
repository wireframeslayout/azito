import { useLongPress, longPressStyle } from '../../hooks/useLongPress';
import { useTranslation } from 'react-i18next';
import { useBlobUrl } from '../../hooks/useBlobUrl';
import { formatSize } from '../../utils/formatSize';
import { formatRelativeTime } from '../../utils/time';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui';
import type { FileEntry } from '../files/backend/FilesBackend';

const IMAGE_NAME = /\.(jpe?g|png|gif|webp|svg|bmp|ico)$/i;
const THUMBNAIL_SIZE = 'var(--space-6)';

function StorageThumbnail({ path }: { path: string }) {
  const { url } = useBlobUrl(path);
  return url
    ? <img src={url} alt="" style={{ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, objectFit: 'cover', borderRadius: 'var(--radius-sm)', flexShrink: 0 }} />
    : <Icon name="image" size={16} />;
}

interface StorageEntryRowProps {
  entry: FileEntry;
  rawPath: string;
  isSelected: boolean;
  isActive: boolean;
  mobile: boolean;
  selectionMode: boolean;
  onToggle: () => void;
  onRangeSelect: () => void;
  onOpen: () => void;
  onDownload: () => void;
  onCopyUrl: () => void;
}

export function StorageEntryRow({ entry, rawPath, isSelected, isActive, mobile, selectionMode, onToggle, onRangeSelect, onOpen, onDownload, onCopyUrl }: StorageEntryRowProps) {
  const { t } = useTranslation('storage');
  const { t: filesT } = useTranslation('files');
  const bindLongPress = useLongPress();
  const touchSize = mobile ? 'calc(var(--space-6) + var(--space-5))' : undefined;
  const meta = entry.type === 'file'
    ? [entry.size !== undefined ? formatSize(entry.size) : null, entry.lastModified ? formatRelativeTime(entry.lastModified) : null].filter(Boolean).join(' · ')
    : '';
  return <div className={`row-hover${isSelected || isActive ? ' row-selected' : ''}`}
    style={{ display: 'flex', alignItems: 'center', minHeight: 'calc(var(--space-6) + var(--space-5))', gap: 'var(--space-2)', padding: '0 var(--space-2)', minWidth: 0 }}>
    <label style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: touchSize, minHeight: touchSize }}><input type="checkbox" aria-label={t('list.select', { name: entry.name })} checked={isSelected} onChange={onToggle} /></label>
    {entry.type === 'directory' ? <Icon name="files" size={16} /> : IMAGE_NAME.test(entry.name) ? <StorageThumbnail path={rawPath} /> : <Icon name="file" size={16} />}
    <button type="button" className="icon-btn"
      {...bindLongPress(onToggle)}
      style={{ ...longPressStyle, flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', background: 'none', border: 'none', padding: 'var(--space-1) 0', color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}
      onClick={(event) => {
        if (mobile && selectionMode) onToggle();
        else if (event.shiftKey) onRangeSelect();
        else if (event.ctrlKey || event.metaKey) onToggle();
        else onOpen();
      }}>
      <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--font-sm)' }}>{entry.name}</span>
      {meta && <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>{meta}</span>}
    </button>
    {entry.type === 'file' && <>
      <IconButton size="sm" style={{ minWidth: touchSize, minHeight: touchSize }} type="button" aria-label={filesT('storage.download')} title={filesT('storage.download')} onClick={onDownload}><Icon name="download" size={16} /></IconButton>
      <IconButton size="sm" style={{ minWidth: touchSize, minHeight: touchSize }} type="button" aria-label={filesT('storage.copyUrl')} title={filesT('storage.copyUrl')} onClick={onCopyUrl}><Icon name="external-link" size={16} /></IconButton>
    </>}
  </div>;
}

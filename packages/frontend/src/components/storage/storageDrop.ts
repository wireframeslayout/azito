export type StorageDropItem =
  | { type: 'directory'; path: string }
  | { type: 'file'; path: string; file: File }
  | { type: 'error'; path: string; error: string };

export interface StorageDropFailure { path: string; error: string }
export interface StorageDropResult { completed: number; total: number; failures: StorageDropFailure[] }
export interface StorageDropOperations {
  createFolder: (path: string) => Promise<void>;
  uploadFile: (file: File, prefix: string) => Promise<void>;
  onProgress: (completed: number, total: number) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readDirectory(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

async function collectEntry(entry: FileSystemEntry, parent: string): Promise<StorageDropItem[]> {
  const path = `${parent}${entry.name}`;
  try {
    if (entry.isFile) return [{ type: 'file', path, file: await readFile(entry as FileSystemFileEntry) }];
    if (!entry.isDirectory) throw new Error('Unsupported dropped item');
    const prefix = `${path}/`;
    const children = await readDirectory(entry as FileSystemDirectoryEntry);
    const result: StorageDropItem[] = [{ type: 'directory', path: prefix }];
    for (const child of children) result.push(...await collectEntry(child, prefix));
    return result;
  } catch (error) {
    return [{ type: 'error', path, error: errorMessage(error) }];
  }
}

export async function collectStorageDrop(transfer: DataTransfer): Promise<StorageDropItem[]> {
  // DataTransferItem access is only valid during the drop event, before the first await.
  const sources = Array.from(transfer.items).filter((item) => item.kind === 'file').map((item) => ({
    entry: typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null,
    file: item.getAsFile(),
  }));
  const result: StorageDropItem[] = [];
  for (const source of sources) {
    if (source.entry) result.push(...await collectEntry(source.entry, ''));
    else if (source.file) result.push({ type: 'file', path: source.file.name, file: source.file });
    else result.push({ type: 'error', path: '', error: 'Unable to read dropped item' });
  }
  return result;
}

export async function uploadStorageDrop(items: StorageDropItem[], prefix: string, operations: StorageDropOperations): Promise<StorageDropResult> {
  const failures: StorageDropFailure[] = [];
  let completed = 0;
  operations.onProgress(completed, items.length);
  for (const item of items) {
    try {
      if (item.type === 'error') throw new Error(item.error);
      if (item.type === 'directory') await operations.createFolder(`${prefix}${item.path}`);
      else await operations.uploadFile(item.file, `${prefix}${item.path.slice(0, item.path.lastIndexOf('/') + 1)}`);
    } catch (error) {
      failures.push({ path: item.path, error: errorMessage(error) });
    }
    operations.onProgress(++completed, items.length);
  }
  return { completed, total: items.length, failures };
}

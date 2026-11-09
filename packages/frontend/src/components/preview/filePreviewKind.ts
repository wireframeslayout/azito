export type FilePreviewKind = 'csv' | 'xlsx' | 'docx' | 'pptx' | 'video' | 'audio' | 'legacy' | 'other';
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac']);
const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v']);
export function filePreviewKind(name: string): FilePreviewKind {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'xlsx' || ext === 'docx' || ext === 'pptx') return ext;
  if (ext && AUDIO.has(ext)) return 'audio';
  if (ext && VIDEO.has(ext)) return 'video';
  if (ext === 'doc' || ext === 'xls' || ext === 'ppt') return 'legacy';
  return 'other';
}

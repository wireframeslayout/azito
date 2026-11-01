export type StorageErrorCode = 'dns' | 'refused' | 'timeout' | 'auth' | 'bucket' | 'unknown';

const messages: Record<StorageErrorCode, string> = {
  dns: 'Storage hostname could not be resolved.',
  refused: 'Storage connection was refused.',
  timeout: 'Storage connection timed out.',
  auth: 'Storage authentication failed.',
  bucket: 'Storage bucket was not found.',
  unknown: 'Storage is unavailable.',
};

export function classifyStorageError(error: unknown): { code: StorageErrorCode; error: string } {
  const value = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } } | null;
  const code = value?.code ?? value?.name;
  const status = value?.$metadata?.httpStatusCode;
  let reason: StorageErrorCode = 'unknown';
  if (status === 401 || status === 403 || code === 'AccessDenied' || code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch') reason = 'auth';
  else if (status === 404 || code === 'NotFound' || code === 'NoSuchBucket') reason = 'bucket';
  else if (code === 'TimeoutError' || code === 'AbortError' || code === 'ETIMEDOUT') reason = 'timeout';
  else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') reason = 'dns';
  else if (code === 'ECONNREFUSED') reason = 'refused';
  return { code: reason, error: messages[reason] };
}

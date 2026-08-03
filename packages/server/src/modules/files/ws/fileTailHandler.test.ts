import { describe, it, expect } from 'vitest';
import path from 'path';

// Test the path validation logic from fileTailHandler
// (extracted for unit testing since the handler itself needs a real WebSocket)
const ALLOWED_PREFIX = '/tmp/azito-pipe-';

function isPathAllowed(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(ALLOWED_PREFIX);
}

describe('fileTailHandler path validation', () => {
  it('should allow valid azito pipe paths', () => {
    expect(isPathAllowed('/tmp/azito-pipe-42-1234567890.log')).toBe(true);
  });

  it('should allow nested pipe paths under /tmp/azito-pipe-', () => {
    expect(isPathAllowed('/tmp/azito-pipe-test/file.log')).toBe(true);
  });

  it('should reject paths outside /tmp/azito-pipe-', () => {
    expect(isPathAllowed('/etc/passwd')).toBe(false);
  });

  it('should reject path traversal via ../', () => {
    expect(isPathAllowed('/tmp/azito-pipe-../../etc/passwd')).toBe(false);
  });

  it('should reject path traversal encoded in middle', () => {
    expect(isPathAllowed('/tmp/azito-pipe-foo/../../../etc/shadow')).toBe(false);
  });

  it('should reject /tmp/azito-pipefake (no dash after prefix)', () => {
    // /tmp/azito-pipefake starts with /tmp/azito-pipe — but that's
    // still under the allowed prefix, so this is actually allowed.
    // The prefix is '/tmp/azito-pipe-' (with trailing dash).
    expect(isPathAllowed('/tmp/azito-pipefake')).toBe(false);
  });

  it('should reject relative paths', () => {
    expect(isPathAllowed('tmp/azito-pipe-test.log')).toBe(false);
  });
});

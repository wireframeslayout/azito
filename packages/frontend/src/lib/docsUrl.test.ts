import { describe, it, expect } from 'vitest';
import { buildDocsUrl } from './docsUrl';

describe('buildDocsUrl', () => {
  it('resolves ja to the Japanese doc', () => {
    expect(buildDocsUrl('ja', 'isolated-execution')).toBe(
      'https://github.com/wireframeslayout/azito/blob/master/docs/ja/isolated-execution.md',
    );
  });

  it('resolves ja-JP to the Japanese doc', () => {
    expect(buildDocsUrl('ja-JP', 'security-setup')).toBe(
      'https://github.com/wireframeslayout/azito/blob/master/docs/ja/security-setup.md',
    );
  });

  it('resolves JA (uppercase) to the Japanese doc', () => {
    expect(buildDocsUrl('JA', 'isolated-execution')).toBe(
      'https://github.com/wireframeslayout/azito/blob/master/docs/ja/isolated-execution.md',
    );
  });

  it('resolves en to the English doc', () => {
    expect(buildDocsUrl('en', 'isolated-execution')).toBe(
      'https://github.com/wireframeslayout/azito/blob/master/docs/en/isolated-execution.md',
    );
  });

  it('resolves en-US to the English doc', () => {
    expect(buildDocsUrl('en-US', 'security-setup')).toBe(
      'https://github.com/wireframeslayout/azito/blob/master/docs/en/security-setup.md',
    );
  });

  it('falls back to en for an unknown language', () => {
    expect(buildDocsUrl('fr', 'isolated-execution')).toBe(
      'https://github.com/wireframeslayout/azito/blob/master/docs/en/isolated-execution.md',
    );
  });

  it('falls back to en for an empty language', () => {
    expect(buildDocsUrl('', 'isolated-execution')).toBe(
      'https://github.com/wireframeslayout/azito/blob/master/docs/en/isolated-execution.md',
    );
  });
});

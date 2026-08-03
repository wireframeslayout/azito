import { describe, expect, it, vi } from 'vitest';
import { createOsc52Extractor } from '../utils/osc52';

function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function osc52(text: string, terminator = '\x07'): string {
  return `\x1b]52;c;${encode(text)}${terminator}`;
}

describe('createOsc52Extractor', () => {
  it('extracts a single BEL-terminated sequence', () => {
    const onCopy = vi.fn();
    const extract = createOsc52Extractor(onCopy);

    extract(osc52('hello'));

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith('hello');
  });

  it('extracts an ST-terminated sequence', () => {
    const onCopy = vi.fn();
    const extract = createOsc52Extractor(onCopy);

    extract(osc52('hello st', '\x1b\\'));

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith('hello st');
  });

  it('extracts multiple sequences in one chunk', () => {
    const onCopy = vi.fn();
    const extract = createOsc52Extractor(onCopy);

    extract(`${osc52('first')}middle${osc52('second')}`);

    expect(onCopy).toHaveBeenCalledTimes(2);
    expect(onCopy).toHaveBeenNthCalledWith(1, 'first');
    expect(onCopy).toHaveBeenNthCalledWith(2, 'second');
  });

  it('buffers a sequence split in the middle of base64', () => {
    const onCopy = vi.fn();
    const extract = createOsc52Extractor(onCopy);
    const sequence = osc52('split payload');
    const splitAt = sequence.indexOf(encode('split payload').slice(3, 7));

    extract(sequence.slice(0, splitAt));
    expect(onCopy).not.toHaveBeenCalled();

    extract(sequence.slice(splitAt));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith('split payload');
  });

  it('buffers a sequence split immediately after ESC in an ST terminator', () => {
    const onCopy = vi.fn();
    const extract = createOsc52Extractor(onCopy);
    const sequence = osc52('after esc', '\x1b\\');
    const splitAt = sequence.length - 1;

    extract(sequence.slice(0, splitAt));
    expect(onCopy).not.toHaveBeenCalled();

    extract(sequence.slice(splitAt));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith('after esc');
  });

  it('extracts a base64 payload larger than 5KB', () => {
    const onCopy = vi.fn();
    const extract = createOsc52Extractor(onCopy);
    const payload = 'x'.repeat(5200);

    extract(osc52(payload));

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith(payload);
  });

  it('ignores non-OSC52 data', () => {
    const onCopy = vi.fn();
    const extract = createOsc52Extractor(onCopy);

    extract('plain terminal output\nmore output');

    expect(onCopy).not.toHaveBeenCalled();
  });

  it('extracts OSC52 data mixed with normal data', () => {
    const onCopy = vi.fn();
    const extract = createOsc52Extractor(onCopy);

    extract(`before ${osc52('mixed')} after`);

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith('mixed');
  });

  it('skips invalid base64 without throwing', () => {
    const onCopy = vi.fn();
    const extract = createOsc52Extractor(onCopy);

    expect(() => extract('\x1b]52;c;abc===\x07')).not.toThrow();
    expect(onCopy).not.toHaveBeenCalled();
  });
});

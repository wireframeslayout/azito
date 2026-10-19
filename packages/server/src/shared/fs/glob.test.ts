import { describe, expect, it } from 'vitest';
import { compileGlob } from './glob';

describe('compileGlob', () => {
  it('reads * ? and [set] as find -name does, and everything else literally', () => {
    expect(compileGlob('*.ts', true)('a.b.ts')).toBe(true);
    expect(compileGlob('*.ts', true)('a.tsx')).toBe(false);
    expect(compileGlob('a?c', true)('abc')).toBe(true);
    expect(compileGlob('a?c', true)('ac')).toBe(false);
    expect(compileGlob('[ab]x', true)('bx')).toBe(true);
    expect(compileGlob('[!ab]x', true)('bx')).toBe(false);
    expect(compileGlob('[!ab]x', true)('cx')).toBe(true);
    expect(compileGlob('[a-c]x', true)('bx')).toBe(true);
    expect(compileGlob('[a-c]x', true)('dx')).toBe(false);
    expect(compileGlob('a.b(c)+', true)('a.b(c)+')).toBe(true);
    expect(compileGlob('a.b(c)+', true)('aXb(c)+')).toBe(false);
    expect(compileGlob('a\\*b', true)('a*b')).toBe(true);
    expect(compileGlob('a\\*b', true)('axb')).toBe(false);
    expect(compileGlob('[x', true)('[x')).toBe(true);
  });

  it('matches the whole text, with * crossing a slash (find -path)', () => {
    expect(compileGlob('*/src/*.ts', true)('/p/src/a.ts')).toBe(true);
    expect(compileGlob('abc', true)('xabcx')).toBe(false);
    expect(compileGlob('*', true)('')).toBe(true);
    expect(compileGlob('', true)('')).toBe(true);
    expect(compileGlob('', true)('a')).toBe(false);
  });

  it('honors case', () => {
    expect(compileGlob('abc', true)('ABC')).toBe(false);
    expect(compileGlob('abc', false)('ABC')).toBe(true);
    expect(compileGlob('[a-c]', false)('B')).toBe(true);
  });

  it('compares case per character, so a letter whose lower case is longer does not shift the text', () => {
    expect(compileGlob('?', false)('\u0130')).toBe(true);
    expect(compileGlob('\u0130x', false)('\u0130X')).toBe(true);
    expect(/^.$/i.test('\u0130')).toBe(true);
  });

  it('backtracks to the last star only, so many stars cannot make it run long', () => {
    const matches = compileGlob('*a*a*a*a*a*a*a*a*a*a*a*b', true);
    const started = Date.now();
    expect(matches('a'.repeat(5000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

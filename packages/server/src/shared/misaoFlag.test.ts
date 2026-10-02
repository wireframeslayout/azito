import { afterEach, describe, expect, it } from 'vitest';
import { resolveMisaoEnabled } from './misaoFlag';

describe('resolveMisaoEnabled', () => {
  const original = process.env.AZITO_EXPERIMENTAL_MISAO;
  afterEach(() => {
    if (original === undefined) delete process.env.AZITO_EXPERIMENTAL_MISAO;
    else process.env.AZITO_EXPERIMENTAL_MISAO = original;
  });

  it.each([['1', true], ['true', true], ['0', false], ['false', false], ['', false], ['yes', false]])('treats %j as %s', (value, expected) => {
    process.env.AZITO_EXPERIMENTAL_MISAO = value;
    expect(resolveMisaoEnabled()).toBe(expected);
  });

  it('is off when unset', () => {
    delete process.env.AZITO_EXPERIMENTAL_MISAO;
    expect(resolveMisaoEnabled()).toBe(false);
  });
});

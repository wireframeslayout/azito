import { describe, expect, it } from 'vitest';
import { isOperatorRequiredError } from './operatorRequired';

describe('isOperatorRequiredError', () => {
  it('operator_required の 403 ボディを true と判定する', () => {
    expect(isOperatorRequiredError(403, { error: 'operator_required', operation: 'units.execute' })).toBe(true);
  });

  it('403 以外は false', () => {
    expect(isOperatorRequiredError(200, { error: 'operator_required', operation: 'units.execute' })).toBe(false);
  });

  it('operation が欠けていれば false', () => {
    expect(isOperatorRequiredError(403, { error: 'operator_required' })).toBe(false);
  });

  it('別の error 値は false', () => {
    expect(isOperatorRequiredError(403, { error: 'forbidden', operation: 'x' })).toBe(false);
  });

  it('null/非オブジェクト/undefined は false', () => {
    expect(isOperatorRequiredError(403, null)).toBe(false);
    expect(isOperatorRequiredError(403, 'plain text')).toBe(false);
    expect(isOperatorRequiredError(403, undefined)).toBe(false);
  });
});

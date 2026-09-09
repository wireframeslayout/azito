import { describe, it, expect } from 'vitest';
import { tmuxKeyToZellij, tmuxKeysToZellij } from './zellijKeyMap';

describe('tmuxKeyToZellij', () => {
  it('maps Enter to bytes [13]', () => {
    expect(tmuxKeyToZellij('Enter')).toEqual({ type: 'bytes', values: [13] });
  });
  it('maps Escape to bytes [27]', () => {
    expect(tmuxKeyToZellij('Escape')).toEqual({ type: 'bytes', values: [27] });
  });
  it('maps Tab to bytes [9]', () => {
    expect(tmuxKeyToZellij('Tab')).toEqual({ type: 'bytes', values: [9] });
  });
  it('maps Space to bytes [32]', () => {
    expect(tmuxKeyToZellij('Space')).toEqual({ type: 'bytes', values: [32] });
  });
  it('maps BSpace to bytes [127]', () => {
    expect(tmuxKeyToZellij('BSpace')).toEqual({ type: 'bytes', values: [127] });
  });
  it('maps arrow keys', () => {
    expect(tmuxKeyToZellij('Up')).toEqual({ type: 'bytes', values: [27, 91, 65] });
    expect(tmuxKeyToZellij('Down')).toEqual({ type: 'bytes', values: [27, 91, 66] });
    expect(tmuxKeyToZellij('Right')).toEqual({ type: 'bytes', values: [27, 91, 67] });
    expect(tmuxKeyToZellij('Left')).toEqual({ type: 'bytes', values: [27, 91, 68] });
  });
  it('maps Home/End', () => {
    expect(tmuxKeyToZellij('Home')).toEqual({ type: 'bytes', values: [27, 91, 72] });
    expect(tmuxKeyToZellij('End')).toEqual({ type: 'bytes', values: [27, 91, 70] });
  });
  it('maps PPage/NPage', () => {
    expect(tmuxKeyToZellij('PPage')).toEqual({ type: 'bytes', values: [27, 91, 53, 126] });
    expect(tmuxKeyToZellij('NPage')).toEqual({ type: 'bytes', values: [27, 91, 54, 126] });
  });
  it('maps DC (Delete)', () => {
    expect(tmuxKeyToZellij('DC')).toEqual({ type: 'bytes', values: [27, 91, 51, 126] });
  });
  it('maps C-c to ctrl byte (3)', () => {
    expect(tmuxKeyToZellij('C-c')).toEqual({ type: 'bytes', values: [3] });
  });
  it('maps C-a to ctrl byte (1)', () => {
    expect(tmuxKeyToZellij('C-a')).toEqual({ type: 'bytes', values: [1] });
  });
  it('maps C-z to ctrl byte (26)', () => {
    expect(tmuxKeyToZellij('C-z')).toEqual({ type: 'bytes', values: [26] });
  });
  it('maps M-x to ESC + char', () => {
    expect(tmuxKeyToZellij('M-x')).toEqual({ type: 'bytes', values: [27, 120] });
  });
  it('maps function keys F1-F4', () => {
    expect(tmuxKeyToZellij('F1')).toEqual({ type: 'bytes', values: [27, 79, 80] });
    expect(tmuxKeyToZellij('F4')).toEqual({ type: 'bytes', values: [27, 79, 83] });
  });
  it('maps function keys F5-F12', () => {
    expect(tmuxKeyToZellij('F5').type).toBe('bytes');
    expect(tmuxKeyToZellij('F12').type).toBe('bytes');
  });
  it('passes through plain characters as chars', () => {
    expect(tmuxKeyToZellij('a')).toEqual({ type: 'chars', value: 'a' });
    expect(tmuxKeyToZellij('Z')).toEqual({ type: 'chars', value: 'Z' });
    expect(tmuxKeyToZellij('/')).toEqual({ type: 'chars', value: '/' });
  });
});

describe('tmuxKeysToZellij', () => {
  it('maps an array of keys', () => {
    const result = tmuxKeysToZellij(['C-c', 'Enter', 'a']);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'bytes', values: [3] });
    expect(result[1]).toEqual({ type: 'bytes', values: [13] });
    expect(result[2]).toEqual({ type: 'chars', value: 'a' });
  });
});

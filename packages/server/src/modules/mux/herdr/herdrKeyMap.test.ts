import { describe, it, expect } from 'vitest';
import { tmuxKeyToHerdr, tmuxKeysToHerdr } from './herdrKeyMap';

describe('tmuxKeyToHerdr', () => {
  it('maps Enter', () => expect(tmuxKeyToHerdr('Enter')).toBe('enter'));
  it('maps Escape', () => expect(tmuxKeyToHerdr('Escape')).toBe('escape'));
  it('maps Tab', () => expect(tmuxKeyToHerdr('Tab')).toBe('tab'));
  it('maps Space', () => expect(tmuxKeyToHerdr('Space')).toBe('space'));
  it('maps BSpace', () => expect(tmuxKeyToHerdr('BSpace')).toBe('backspace'));
  it('maps arrow keys', () => {
    expect(tmuxKeyToHerdr('Up')).toBe('up');
    expect(tmuxKeyToHerdr('Down')).toBe('down');
    expect(tmuxKeyToHerdr('Left')).toBe('left');
    expect(tmuxKeyToHerdr('Right')).toBe('right');
  });
  it('maps C-c to ctrl+c', () => expect(tmuxKeyToHerdr('C-c')).toBe('ctrl+c'));
  it('maps C-z to ctrl+z', () => expect(tmuxKeyToHerdr('C-z')).toBe('ctrl+z'));
  it('maps M-x to alt+x', () => expect(tmuxKeyToHerdr('M-x')).toBe('alt+x'));
  it('maps function keys', () => {
    expect(tmuxKeyToHerdr('F1')).toBe('f1');
    expect(tmuxKeyToHerdr('F12')).toBe('f12');
  });
  it('passes through plain characters', () => {
    expect(tmuxKeyToHerdr('a')).toBe('a');
    expect(tmuxKeyToHerdr('Z')).toBe('Z');
  });
  it('maps PPage/NPage', () => {
    expect(tmuxKeyToHerdr('PPage')).toBe('pageup');
    expect(tmuxKeyToHerdr('NPage')).toBe('pagedown');
  });
});

describe('tmuxKeysToHerdr', () => {
  it('maps an array of keys', () => {
    expect(tmuxKeysToHerdr(['C-c', 'Enter', 'a'])).toEqual(['ctrl+c', 'enter', 'a']);
  });
});

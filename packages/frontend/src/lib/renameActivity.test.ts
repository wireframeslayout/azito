import { describe, expect, it } from 'vitest';
import { renameActivity } from './renameActivity';

describe('renameActivity', () => {
  it('updates only unregistered entries in the matching server and window', () => {
    const entry = { serverName: 'one', target: 'session:window.1', finishedAt: 123 };
    const event = { serverName: 'one', target: 'session:window', newName: 'new' };
    expect(renameActivity(entry, event)).toEqual({ ...entry, label: 'new', labelSource: 'user' });
    expect(renameActivity({ ...entry, serverName: 'two' }, event)).toEqual({ ...entry, serverName: 'two' });
    expect(renameActivity({ ...entry, windowId: 7 }, event)).toEqual({ ...entry, windowId: 7 });
    expect(renameActivity(entry, { ...event, target: 'session:other' })).toBe(entry);
  });
});


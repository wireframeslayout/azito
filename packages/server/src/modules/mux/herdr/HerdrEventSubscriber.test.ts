import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HerdrEventSubscriber, type HerdrEvent } from './HerdrEventSubscriber';

describe('HerdrEventSubscriber', () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup.length = 0;
  });

  it('receives events after subscribing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-evt-'));
    const sockPath = join(dir, 'herdr.sock');

    const server = createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const idx = buf.indexOf('\n');
        if (idx === -1) return;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const req = JSON.parse(line);
        conn.write(JSON.stringify({ id: req.id, type: 'subscribed' }) + '\n');
        setTimeout(() => {
          conn.write(JSON.stringify({
            type: 'pane.agent_status_changed',
            pane_id: 'w1:p1',
            agent_status: 'working',
          }) + '\n');
        }, 50);
      });
    });
    server.listen(sockPath);
    cleanup.push(() => { server.close(); try { rmSync(dir, { recursive: true }); } catch {} });

    const sub = new HerdrEventSubscriber(sockPath, [{ type: 'pane.agent_status_changed', pane_id: '*' }]);
    cleanup.push(() => sub.stop());

    const received: HerdrEvent[] = [];
    sub.on('event', (evt: HerdrEvent) => received.push(evt));
    sub.start();

    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('pane.agent_status_changed');
    expect(received[0].pane_id).toBe('w1:p1');
    expect(received[0].agent_status).toBe('working');
  });

  it('stop prevents reconnection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-stop-'));
    const sockPath = join(dir, 'herdr.sock');

    const server = createServer(() => {});
    server.listen(sockPath);
    cleanup.push(() => { server.close(); try { rmSync(dir, { recursive: true }); } catch {} });

    const sub = new HerdrEventSubscriber(sockPath, [{ type: 'pane.agent_status_changed', pane_id: '*' }]);
    sub.start();
    await new Promise((r) => setTimeout(r, 50));
    sub.stop();
    expect(true).toBe(true);
  });
});

// Real herdr 0.8.2 stream lines (captured on server007): the ack is `{id, result}`, events are
// `{event: 'tab_created', data: {type: 'tab_created', ...}}`. The old parser required a top-level
// `type` and therefore never emitted anything.
import { normaliseHerdrEventLine, herdrEventTypeToDotted } from './HerdrEventSubscriber';
describe('normaliseHerdrEventLine (herdr 0.8.2 wire format)', () => {
  it('drops the subscription ack and errors', () => {
    expect(normaliseHerdrEventLine({ id: 'S', result: { type: 'subscription_started' } })).toBeNull();
    expect(normaliseHerdrEventLine({ id: '', error: { code: 'invalid_request', message: 'x' } })).toBeNull();
  });
  it('flattens {event,data} into a dotted-type event', () => {
    const ev = normaliseHerdrEventLine({ event: 'tab_created', data: { type: 'tab_created', tab: { tab_id: 'w1:t4', label: '4' } } });
    expect(ev?.type).toBe('tab.created');
    expect((ev as { tab?: { tab_id: string } }).tab?.tab_id).toBe('w1:t4');
    const st = normaliseHerdrEventLine({ event: 'pane_agent_status_changed', data: { type: 'pane_agent_status_changed', pane_id: 'w1:p2', workspace_id: 'w1', agent_status: 'blocked' } });
    expect(st?.type).toBe('pane.agent_status_changed');
    expect((st as { agent_status?: string }).agent_status).toBe('blocked');
  });
  it('maps underscore names to the dotted vocabulary', () => {
    expect(herdrEventTypeToDotted('workspace_metadata_updated')).toBe('workspace.metadata_updated');
    expect(herdrEventTypeToDotted('pane.output_matched')).toBe('pane.output_matched');
  });
});

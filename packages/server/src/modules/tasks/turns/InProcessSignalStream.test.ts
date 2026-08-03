import { describe, it, expect, vi } from 'vitest';
import { InProcessSignalStream } from './InProcessSignalStream';
import { TurnSignalHub } from './TurnSignalHub';

describe('InProcessSignalStream', () => {
  it('emits marker "phase_complete" on a "complete" signal, regardless of testFailed', () => {
    const hub = new TurnSignalHub();
    const stream = new InProcessSignalStream(hub, 1);
    const markerFn = vi.fn();
    stream.on('marker', markerFn);
    stream.start();

    hub.emitSignal(1, { type: 'complete', testFailed: true });

    expect(markerFn).toHaveBeenCalledWith('phase_complete');
  });

  it('emits marker "questions_json" with a JSON-stringified questions array on a "questions" signal', () => {
    const hub = new TurnSignalHub();
    const stream = new InProcessSignalStream(hub, 1);
    const markerFn = vi.fn();
    stream.on('marker', markerFn);
    stream.start();

    const questions = [{ id: 'q1', text: 'Which branch?' }];
    hub.emitSignal(1, { type: 'questions', questions });

    expect(markerFn).toHaveBeenCalledWith('questions_json', JSON.stringify(questions));
  });

  it('emits "data" on a "progress" signal', () => {
    const hub = new TurnSignalHub();
    const stream = new InProcessSignalStream(hub, 1);
    const dataFn = vi.fn();
    stream.on('data', dataFn);
    stream.start();

    hub.emitSignal(1, { type: 'progress' });

    expect(dataFn).toHaveBeenCalled();
  });

  it('emits marker "phase_complete" on a "fail" signal (unblocks the wait; caller must re-check AgentTurn.status)', () => {
    const hub = new TurnSignalHub();
    const stream = new InProcessSignalStream(hub, 1);
    const markerFn = vi.fn();
    const dataFn = vi.fn();
    stream.on('marker', markerFn);
    stream.on('data', dataFn);
    stream.start();

    hub.emitSignal(1, { type: 'fail', reason: 'crash' });

    expect(markerFn).toHaveBeenCalledWith('phase_complete');
    expect(dataFn).not.toHaveBeenCalled();
  });

  it('does not react to signals for a different turnId', () => {
    const hub = new TurnSignalHub();
    const stream = new InProcessSignalStream(hub, 1);
    const markerFn = vi.fn();
    stream.on('marker', markerFn);
    stream.start();

    hub.emitSignal(2, { type: 'complete', testFailed: false });

    expect(markerFn).not.toHaveBeenCalled();
  });

  it('stops receiving signals after stop() is called', () => {
    const hub = new TurnSignalHub();
    const stream = new InProcessSignalStream(hub, 1);
    const markerFn = vi.fn();
    stream.on('marker', markerFn);
    stream.start();
    stream.stop();

    hub.emitSignal(1, { type: 'complete', testFailed: false });

    expect(markerFn).not.toHaveBeenCalled();
  });

  it('getFilePath returns a sentinel value and getBuffer returns an empty string', () => {
    const hub = new TurnSignalHub();
    const stream = new InProcessSignalStream(hub, 1);

    expect(stream.getFilePath()).toBe('(in-process)');
    expect(stream.getBuffer()).toBe('');
  });

  it('replays a "complete" signal emitted before any "marker" listener is attached, once one is', async () => {
    const hub = new TurnSignalHub();
    const stream = new InProcessSignalStream(hub, 1);
    stream.start();

    // Signal arrives while nothing is listening for 'marker' yet (e.g. during
    // the async gap between sendKeys and waitForWorker registering listeners).
    hub.emitSignal(1, { type: 'complete', testFailed: false });

    const markerFn = vi.fn();
    stream.on('marker', markerFn);
    expect(markerFn).not.toHaveBeenCalled();

    // Flush is deferred to the next tick (see class doc).
    await new Promise((resolve) => process.nextTick(resolve));

    expect(markerFn).toHaveBeenCalledWith('phase_complete');
  });

  it('does not buffer "progress" signals emitted before a "marker" listener is attached', async () => {
    const hub = new TurnSignalHub();
    const stream = new InProcessSignalStream(hub, 1);
    stream.start();

    hub.emitSignal(1, { type: 'progress' });

    const markerFn = vi.fn();
    const dataFn = vi.fn();
    stream.on('marker', markerFn);
    stream.on('data', dataFn);
    await new Promise((resolve) => process.nextTick(resolve));

    expect(markerFn).not.toHaveBeenCalled();
    expect(dataFn).not.toHaveBeenCalled();
  });
});

import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { evaluateRouteAuth, type RouteAuthRequirement } from './routeAuth';
import type { Principal } from './Principal';

function fakeRequest(auth: RouteAuthRequirement | undefined, extra: Record<string, unknown> = {}): FastifyRequest {
  return {
    routeOptions: { method: 'GET', url: '/api/test', config: { auth } },
    url: '/api/test',
    ...extra,
  } as unknown as FastifyRequest;
}

describe('evaluateRouteAuth', () => {
  const operator: Principal = { class: 'operator' };
  const task: Principal = { class: 'task', id: 5 };

  it('allows an operator on a route with no auth config (default-deny for everyone else)', () => {
    const decision = evaluateRouteAuth(operator, fakeRequest(undefined));
    expect(decision.allowed).toBe(true);
  });

  it('denies a non-operator on a route with no auth config', () => {
    const decision = evaluateRouteAuth(task, fakeRequest(undefined));
    expect(decision.allowed).toBe(false);
    expect(decision.operation).toBe('GET /api/test');
  });

  it('allows an operator even on a route that only declares a task-class requirement', () => {
    const decision = evaluateRouteAuth(operator, fakeRequest({ classes: ['task'], condition: () => false }));
    expect(decision.allowed).toBe(true);
  });

  it('denies a task principal whose class is not in the declared classes', () => {
    const decision = evaluateRouteAuth(task, fakeRequest({ classes: ['trigger'] }));
    expect(decision.allowed).toBe(false);
  });

  it('denies a task principal in the declared classes when the condition fails', () => {
    const decision = evaluateRouteAuth(task, fakeRequest({ classes: ['task'], condition: () => false }));
    expect(decision.allowed).toBe(false);
  });

  it('allows a task principal in the declared classes when the condition passes', () => {
    const decision = evaluateRouteAuth(task, fakeRequest({ classes: ['task'], condition: () => true }));
    expect(decision.allowed).toBe(true);
  });

  it('uses the requirement-supplied operation slug over the method/url fallback', () => {
    const decision = evaluateRouteAuth(task, fakeRequest({ classes: [], operation: 'tasks.detail' }));
    expect(decision.operation).toBe('tasks.detail');
  });
});

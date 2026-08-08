import type { FastifyRequest } from 'fastify';
import type { Principal, PrincipalClass } from './Principal';

/**
 * Declares which non-operator principal classes may reach a route, evaluated
 * by the onRequest hook in buildServer.ts via `evaluateRouteAuth()` below.
 *
 * Operators always pass regardless of this declaration (design v3 §4: "operator
 * は全部通る") — a route only needs this when it wants to allowlist a
 * *narrower* principal for a read it must serve without an operator token
 * (e.g. a task fetching its own phase prompt). A route with no `auth` config
 * at all defaults to operator-only (design v3 §4: default-deny).
 *
 * `condition` is where relationship checks live — e.g. "the task token's
 * task id matches :id in the URL". Extension point (design v3 §1 note b):
 * #62's trigger-class routes and future agent-to-agent relationship checks
 * (e.g. "task A may read task B because a link exists between them") are
 * new condition functions passed here, never inline
 * `if (principal.class === 'task' && ...)` branches spread across route
 * handlers.
 */
export interface RouteAuthRequirement {
  classes: PrincipalClass[];
  condition?: (principal: Principal, request: FastifyRequest) => boolean;
  /** Slug reported in the 403 body and audit log; defaults to `${method} ${routePath}`. */
  operation?: string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuthRequirement;
  }
}

export interface RouteAuthDecision {
  allowed: boolean;
  operation: string;
}

/**
 * Single evaluation point for "may this principal reach this route" (design
 * v3 §1: "認可の判断構造は claim 評価と同型"). Called from buildServer.ts's
 * onRequest hook after the principal has already been resolved from the
 * Authorization header — this function never touches request headers or
 * tokens itself.
 */
export function evaluateRouteAuth(principal: Principal, request: FastifyRequest): RouteAuthDecision {
  const requirement = request.routeOptions.config?.auth;
  const operation = requirement?.operation ?? `${request.routeOptions.method as string} ${request.routeOptions.url ?? request.url}`;

  if (principal.class === 'operator') return { allowed: true, operation };
  if (!requirement) return { allowed: false, operation };
  if (!requirement.classes.includes(principal.class)) return { allowed: false, operation };
  if (requirement.condition && !requirement.condition(principal, request)) return { allowed: false, operation };
  return { allowed: true, operation };
}

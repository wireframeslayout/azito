import type { ITaskRepository, Task } from '../Task';
import { deriveInputTrust } from '../Task';
import type { AuditLogService } from '../../../shared/audit/AuditLogService';
import type { Principal } from '../../../shared/auth/Principal';

/** Everything a caller must supply to create a task, EXCEPT the fields this service itself derives/stamps (inputTrust, createdByKind, createdById) or the repository stamps (id/createdAt/updatedAt). */
export type TaskOriginationFields = Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'inputTrust' | 'createdByKind' | 'createdById'>;

export interface TaskOrigin {
  kind: Task['createdByKind'];
  id: number | null;
}

/**
 * The single funnel every task-creation code path goes through (Issue #28
 * design v3 §5) — `POST /api/tasks` (modules/tasks/routes.ts),
 * `POST /api/projects/:id/import-issue` (modules/projects/routes.ts),
 * `POST /api/tasks/:id/children` (modules/tasks/routes.ts), and MCP (which
 * itself just calls `POST /api/tasks` over HTTP, so it needs no separate
 * wiring — see harness/skills/azt-mcp/mcp-server/index.js). Before this
 * service existed, `inputTrust` derivation was already unified into
 * {@link deriveInputTrust} (Issue #328), but callers still each decided
 * `source`/trust and called `taskRepo.create()` directly — this closes the
 * remaining "two call sites can drift" gap by making the repository write
 * itself, plus the audit log entry, something only this class does.
 *
 * `origin` is caller-supplied, not read from `request.principal` internally
 * — POST /api/tasks/:id/children fixes it to `{ kind: 'task', id: parentId
 * }` regardless of which principal (task or operator) actually issued the
 * request (design v3 §4/§5: the child's origin is the PARENT TASK, not
 * whoever clicked the button), while POST /api/tasks and import-issue derive
 * it from `request.principal` at the route (both are operator-only routes
 * today, so `origin.kind` is 'operator' there in practice — but deriving it
 * from the actual principal rather than hardcoding 'operator' keeps this
 * correct if either route's auth declaration widens later without every
 * caller needing to remember to update this argument too).
 */
export class TaskOriginationService {
  constructor(
    private taskRepo: ITaskRepository,
    private auditLogService: AuditLogService,
  ) {}

  create(fields: TaskOriginationFields, origin: TaskOrigin, actor: Principal): number {
    const inputTrust = deriveInputTrust(origin.kind, fields.source);
    const id = this.taskRepo.create({
      ...fields,
      inputTrust,
      createdByKind: origin.kind,
      createdById: origin.id,
    });
    this.auditLogService.record({
      actorClass: actor.class,
      actorId: actor.id ?? null,
      event: 'task.created',
      detail: { taskId: id, createdByKind: origin.kind, createdById: origin.id, source: fields.source, inputTrust },
    });
    return id;
  }
}

<software_design_principles>
Design as a senior architect for this codebase. Follow the project's CLAUDE.md and
rules. Before proposing structure, search for existing similar code and match its
approach — do not introduce a pattern the codebase has no precedent for.

## Clarify before building
- During planning, list your assumptions explicitly and ask the user about any
  genuine ambiguity before implementation, not during it.
- State scope and not-in-scope up front, so unrelated work is excluded by design.

## Design perspectives
- Responsibility separation: one module, one reason to change. Flag concerns that
  leak across boundaries.
- Dependency direction: higher layers depend on lower ones, never the reverse;
  no circular dependencies. Children do not know their parents.
- Abstraction level: keep a single function at one altitude; do not mix
  high-level orchestration with low-level detail.
- Coupling and cohesion: prefer loose coupling through clear interfaces and high
  cohesion within a module.
- Boundary validation: validate at system edges (user input, external APIs);
  trust resolved values within internal code (Resolve at the Boundary).
- Error strategy: define behavior on dependency failure, timeout, and partial
  failure. Fail fast on missing required data; do not hide it behind a fallback.
- Testability: keep units isolatable; avoid hidden global state.

## Make tradeoffs explicit
- For each significant decision, record rationale, the alternatives considered,
  and the consequences (what gets easier, harder, or deferred). Compare on stated
  axes such as complexity, maintainability, extensibility, and cost.

## Anti-patterns to avoid and to flag in review
- Over-abstraction / over-engineering: more structure than the problem needs.
- God object: one unit holding too many responsibilities.
- Circular dependencies between modules.
- Fallback overuse that swallows errors; catch blocks that hide failures.
- Dead code: unused functions, types, exports, imports.
- Premature optimization; speculative "future-proofing" code written before it is
  needed.
- Scope creep: changes beyond the requested task.

## Plan output shape
- areas / API surface / components / data models / data flow.
- ordered, review-sized implementation steps.
- after planning, verify the plan against the requirements before finishing.
</software_design_principles>

# Contributing to AZITO

Thank you for your interest in contributing to AZITO! Contributions of all kinds are welcome — bug reports, feature proposals, documentation improvements, and code.

## Filing Issues

- Search existing issues first to avoid duplicates.
- For bugs, include reproduction steps, expected vs. actual behavior, and your environment (OS, Node.js version, tmux version).
- For feature requests, describe the use case and the problem you are trying to solve, not only the proposed solution.
- **Do not report security vulnerabilities in public issues.** See [SECURITY.md](SECURITY.md) instead.

## Proposing Changes

1. Fork the repository and create a branch from `master`.
2. Make your changes, following the guidelines below.
3. Ensure all quality gates pass (see [Testing and Quality Gates](#testing-and-quality-gates)).
4. Open a pull request against `master` with a clear description of what the change does and why.

For larger changes, please open an issue first to discuss the approach before investing significant effort.

## Development Setup

Requirements: Node.js (v24 recommended), tmux 3.x, a POSIX-like environment (Linux/WSL2/macOS).

```bash
git clone https://github.com/wireframeslayout/azito.git
cd azito
npm install        # installs all workspaces (npm workspaces monorepo)

npm run dev        # starts backend (Fastify, http://localhost:3001)
                   # + frontend (Vite, http://localhost:5173) with hot reload
```

- The backend runs via `tsx watch` and auto-reloads on file changes. Note that `tsx watch` does **not** type-check — run `tsc --noEmit` to catch type errors.
- Local environment variables go in `packages/server/.env` (git-ignored, auto-loaded in dev). For example, set `AZITO_WEBHOOK_TOKEN` there to persist a fixed webhook token across restarts.

## Testing and Quality Gates

All of the following must pass before a PR can be merged:

```bash
npx -w packages/server vitest run          # server unit tests
npx -w packages/server tsc --noEmit       # server type check
npx -w packages/frontend tsc --noEmit     # frontend type check
npm run depcruise                         # dependency direction / circular dependency check
```

Please add or update tests for behavior you change.

## Module Structure Rules

The server follows a feature-first layout under `packages/server/src/modules/` — one feature = one module, with routes, service, and repository living together in `modules/<name>/`.

Dependency direction is strictly one-way:

```
shared → base (tmux, servers) → mid (agents, git, llm, prompt, sidekicks)
       → upper (tasks, windows, units, operations, projects, files, usage, notifications)
       → main.ts
```

- Circular dependencies are forbidden; this is enforced by dependency-cruiser (`npm run depcruise`, rules in `.dependency-cruiser.cjs`).
- Keep `routes.ts` thin: request/response mapping and service calls only. Business logic belongs in services/use cases.
- Define an `I~` interface only when there are two or more implementations.

## Adding a Database Migration

1. Create `packages/server/src/shared/db/migrations/NNN_description.ts` (use the next sequential number).
2. Export `version`, `description`, and an `up(db)` function.
3. Import the file in `Database.ts` and add it to the `migrations` array.

## Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add task summary extraction
fix: prevent duplicate PR creation on recovery
refactor: extract PaneClassifier from LlmClient
docs: / test: / chore: ...
```

One commit = one logical change.

## Contributor License Agreement (CLA)

All contributors must agree to the [Contributor License Agreement](CLA.md) before their first pull request is merged. Signing is handled automatically: a CLA bot will comment on your PR with instructions, and you indicate agreement by replying with the requested comment. You only need to sign once; subsequent PRs are covered.

If you are contributing on behalf of an employer, a Corporate CLA is available on request — see [CLA.md](CLA.md).

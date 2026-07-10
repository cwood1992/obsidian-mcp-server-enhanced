# Review Agents

Read-only Claude Code review agents, one per specialist reviewer persona. Each is
scoped with `tools: Read, Grep, Glob, Bash` (Bash restricted in the prompt to
read-only commands like `git diff`/`git log`) and never edits files.

- **ai-slop-reviewer** — mechanically generated, over-broad, brittle, or performative code: fake fallbacks, one-caller abstractions, swallowed errors, boilerplate inconsistent with repo style.
- **api-data-contracts-reviewer** — drift/risk in APIs, schemas, migrations, persisted data shape, generated clients, and serialization boundaries between producers and consumers.
- **dead-code-reviewer** — unused exports, stale entrypoints, abandoned config, unreachable branches, obsolete tests, and dead docs.
- **dependencies-build-reviewer** — dependency, lockfile, build script, CI, Dockerfile, release, and generated-artifact risk, including command drift between docs/CI/scripts.
- **doc-code-delta-reviewer** — documentation, examples, comments/docstrings, and runbooks that disagree with actual implementation or runtime behavior.
- **duplication-reviewer** — repeated logic, copied bugs, and inconsistent forks in validation, parsing, API handling, retries, permissions, UI state, and test fixtures.
- **frontend-ux-reviewer** — frontend usability, accessibility, state-management, and user-flow risk: forms, loading/empty/error states, responsive layout, a11y, design-system consistency.
- **reuse-architecture-reviewer** — missed reuse, misplaced responsibilities, and boundary drift across modules, helpers, domain boundaries, and cross-cutting concerns.
- **runtime-observability-reviewer** — issues blocking running, operating, diagnosing, deploying, or recovering the system: startup/shutdown, config, logging/metrics/health checks, retries, idempotency.
- **security-privacy-reviewer** — concrete security/privacy/secret-handling risk: auth gaps, unsafe filesystem/shell/network/deserialization use, leaked secrets or personal data.
- **test-behavior-risk-reviewer** — under-tested behavior, false-confidence tests (mock-heavy, snapshot-only, happy-path-only), and regressions likely to escape review.

These were adapted from the review personas in BoweyLou's
[repo-contract-kit](https://github.com/BoweyLou/kit) (Apache-2.0). The original
prompts targeted a shared review kit (finding templates, session receipts, task
packets); these versions are self-contained — each agent produces its own
ranked findings list directly rather than referencing external templates or
kit tooling.

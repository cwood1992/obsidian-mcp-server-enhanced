# Backlog

This is the portable planning backlog for `obsidian-mcp-server`. Keep top-level
items in checkbox form so `make backlog-status` and
`make agent-task-packet-from-backlog` can discover them.

## ChatGPT Connector Hardening

- [x] OCM-001: Split the ChatGPT-facing connector into a separate facade process (P1)

  Build a dedicated `obsidian-chatgpt` facade instead of serving ChatGPT
  manifest/actions from the same broad local MCP HTTP server. The facade should
  call existing Obsidian service/tool logic internally, but it should have its
  own runtime command, port, health check, launchd entry, docs, and Tailscale
  routing target.

  Rationale: the current ChatGPT layer is bolted onto the native HTTP MCP
  transport. That preserves code reuse, but it also makes the public/hosted
  connector boundary too close to the full local MCP server and its broad vault
  capabilities. Keryx's separate ChatGPT facade is a cleaner pattern: expose a
  smaller, connector-specific surface publicly while keeping the full local MCP
  server private.

  Acceptance criteria:

  - Add a separate startup path such as `npm run start:chatgpt` or an equivalent
    facade command.
  - Keep the existing Claude/local `/mcp` transport behavior unchanged.
  - Add a facade `/health` endpoint that reports service name, public resource
    URL, enabled scopes/capabilities, and auth readiness without leaking secrets.
  - Update README and ops docs so public HTTPS/Funnel guidance points only at
    the facade, not the full MCP server.
  - Add tests that prove ChatGPT facade routes do not require enabling the full
    manifest/actions shim on the local MCP transport.

- [x] OCM-002: Replace query-string API keys with OAuth authorization code plus PKCE for ChatGPT (P1)

  Implement an OAuth 2.1-style authorization flow for the ChatGPT facade:
  discovery metadata, dynamic client registration if needed, `/authorize`,
  `/token`, short-lived authorization codes, PKCE S256 verification, bearer
  access tokens, token expiry, and resource validation.

  Rationale: the current ChatGPT/auth path is a query `api_key` check inherited
  from the local MCP transport. That is simple for local tests, but weak for a
  hosted ChatGPT connector because URLs can be logged, replayed, or copied, and
  the current fallback skips auth when no real key is configured. Keryx's OAuth
  facade gives a better connector boundary while still remaining private and
  local-first.

  Acceptance criteria:

  - Publish OAuth protected-resource and authorization-server metadata from the
    facade.
  - Store authorization codes and access-token hashes locally, not raw tokens.
  - Require PKCE S256 for code exchange.
  - Validate bearer tokens by resource, expiry, and scope before tool execution.
  - Keep query-string API key support only as an explicitly documented local/dev
    fallback, not the recommended ChatGPT connector path.
  - Add tests for successful authorization, expired/used code rejection, bad
    verifier rejection, wrong resource rejection, and missing bearer token
    rejection.

- [x] OCM-003: Add scoped ChatGPT connector capabilities (P1)

  Introduce explicit scopes for ChatGPT-facing tools, separate from the full
  local MCP tool set. Suggested first pass:

  - `obsidian:read`: search, fetch/read page, task query.
  - `obsidian:write`: append/prepend page, create task, update task.
  - `obsidian:dangerous-write`: overwrite page, delete file, broad replace, or
    other destructive/surgical mutation if those are ever exposed.

  Rationale: Keryx's `keryx:read` and `keryx:write` split is a better fit for
  ChatGPT connector authorization than a single all-or-nothing API key. Obsidian
  MCP has more direct vault-manipulation power than Keryx, so destructive or
  broad mutation should either stay out of the ChatGPT facade or require a
  separate high-friction scope.

  Acceptance criteria:

  - Define scope constants and a mapping from facade tool/action to required
    scope.
  - Enforce scope checks server-side for every ChatGPT facade tool.
  - Make read-only connector setup possible without any write tools available.
  - Gate overwrite/delete/search-replace-style operations behind a separate
    dangerous scope or omit them from the facade.
  - Include scope information in tool metadata, manifest/discovery output, and
    docs.
  - Add tests proving read tokens cannot call write tools and write tokens
    cannot call dangerous tools unless explicitly granted.

- [x] OCM-004: Reduce the ChatGPT tool surface to least-privilege connector actions (P2)

  Design a narrow ChatGPT facade API that exposes only the actions ChatGPT needs
  for ordinary vault recall and low-risk capture. Suggested starting surface:

  - `search`
  - `fetch`
  - `task_query`
  - `create_task`
  - `append_note`

  Defer or omit raw overwrite, delete, broad search/replace, command execution,
  template execution, and arbitrary full MCP tool exposure.

  Rationale: the current ChatGPT layer exposes search, fetch, page update,
  task query, task create, and task update. That is useful, but `updatePage`
  includes overwrite behavior and the shape is close to raw vault mutation.
  Keryx's connector is safer because it presents a small memory-specific API
  rather than exposing the full local service.

  Acceptance criteria:

  - Create a facade tool/action list separate from the full MCP tool registry.
  - Rename tools to connector-friendly names where helpful while preserving
    internal service reuse.
  - Remove or disable overwrite mode from the default ChatGPT surface.
  - Add bounded result sizes for search/fetch responses to avoid excessive
    context or accidental large-note exposure.
  - Document which local MCP tools are intentionally not available through the
    ChatGPT facade and why.
  - Add tests for allowed actions and rejected unsupported actions.

- [x] OCM-005: Add connector write audit logging without transcript storage (P1)

  Add a local audit ledger for ChatGPT facade write operations. The log should
  capture enough detail to answer what changed, by which connector client, under
  which scope, and where the result landed, without storing full ChatGPT
  transcripts or entire note bodies.

  Suggested fields:

  - timestamp
  - tool/action name
  - client id or connector subject
  - granted scopes
  - target vault and file path
  - task id or line number when available
  - write mode such as append, prepend, update-task, or overwrite
  - result status and result path
  - short input summary capped to a small length
  - correlation/request id

  Rationale: Keryx's `chatgpt_facade_audit` table is a good pattern for
  accountability. Obsidian MCP writes affect the user's live vault, so connector
  writes should leave a durable local receipt even when the tool call succeeds.

  Acceptance criteria:

  - Add local audit storage, preferably SQLite or another durable local store
    already acceptable for this repo's runtime model.
  - Log successful write operations and rejected write attempts caused by
    missing/insufficient scope.
  - Redact secrets and avoid storing full note content or raw conversation
    transcripts.
  - Include a simple operator inspection path, such as a CLI command or docs for
    querying the latest audit entries.
  - Add tests proving audit rows are written for connector writes and do not
    contain full content bodies.

- [x] OCM-006: Restrict public connectivity guidance to the ChatGPT facade, not raw MCP (P1)

  Update runtime, docs, and helper scripts so Tailscale Funnel or any public
  HTTPS route fronts only the reduced ChatGPT facade. Keep the full Obsidian MCP
  server on localhost or private tailnet-only routes unless a human explicitly
  opts into a dev-only test mode.

  Rationale: Keryx's biggest connectivity lesson is that Tailscale Serve is
  enough for clients inside the tailnet, but ChatGPT infrastructure needs a
  reachable HTTPS endpoint. If Funnel or another public route is used, it should
  terminate at an authenticated, least-privilege facade, never the raw local MCP
  server.

  Acceptance criteria:

  - Add separate Make/script targets for private local MCP exposure and public
    ChatGPT facade exposure.
  - Mark raw MCP Funnel exposure as dev-only or remove it from recommended
    docs.
  - Add docs explaining the local/private/public route split.
  - Verify CORS/host/origin restrictions are appropriate for the facade's public
    URL and stricter than the current broad local HTTP defaults.
  - Add a checklist for confirming the public URL serves only facade endpoints
    and not the full MCP tool surface.

- [x] OCM-007: Preserve Obsidian MCP's live-vault strengths while adopting facade boundaries (P2)

  Keep the core product identity as a capable Obsidian bridge, not a Keryx-style
  memory system. The backport should adopt Keryx's connector boundary patterns
  without importing Keryx's project/area/daily memory model.

  Rationale: Keryx is better for durable memory continuity and governed
  cross-client recall. Obsidian MCP is better for live Obsidian app operations:
  active file, periodic notes, command/template workflows, Tasks-plugin-aware
  task work, frontmatter, links, and surgical note operations. The right update
  is not to turn this repo into Keryx; it is to keep the full local Obsidian
  surface private and expose only a hardened ChatGPT facade publicly.

  Acceptance criteria:

  - Document the distinction between the full local MCP server and the
    ChatGPT-facing facade.
  - Keep existing local/Claude workflows and tool names compatible.
  - Avoid introducing Keryx-specific concepts such as project context packs or
    memory capture classes into the Obsidian MCP core.
  - Add an architecture note describing which Keryx patterns were adopted and
    which were intentionally not adopted.
  - Include migration guidance for existing ChatGPT layer users.

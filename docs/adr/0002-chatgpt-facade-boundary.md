# ADR 0002: ChatGPT Facade Boundary

Status: accepted

Date: 2026-06-22

## Context

The original ChatGPT layer was implemented inside the native HTTP MCP transport.
It reused vault routing and task logic, but it also placed ChatGPT-specific
public routes next to the full local `/mcp` server and reused query-string API
key authentication. That is convenient for local tests, but it is not the right
boundary for a hosted ChatGPT connector or a public Tailscale Funnel route.

Keryx uses a cleaner pattern: a separate ChatGPT-facing facade with a smaller
tool surface, scoped OAuth authorization, local audit logging, and private
backend access to the real memory service.

## Decision

Keep the full Obsidian MCP server as the local/Claude/private-tailnet surface.
Add a separate `obsidian-chatgpt` facade for hosted ChatGPT connector traffic.

The facade:

- runs as its own process through `npm run start:chatgpt`
- listens on its own host/port
- exposes `/health`, OAuth discovery, `/authorize`, `/token`, `/register`,
  `/chatgpt/actions`, and `/audit/recent`
- uses OAuth authorization code with PKCE S256
- validates bearer tokens by resource, expiry, and scope
- exposes a smaller action set than the full local MCP server
- writes local audit entries for write attempts and successful writes

The full local MCP server remains compatible. Existing Claude/local `/mcp`
behavior is not replaced by the facade.

## Adopted From Keryx

- Separate public connector facade instead of publishing the raw local service.
- OAuth/PКCE authorization with hashed local token storage.
- Read/write capability scopes.
- Narrow connector action set.
- Local write audit logging without raw transcript storage.
- Public route guidance that fronts only the facade.

## Intentionally Not Adopted

Keryx's project, area, daily, and durable-memory context-pack model is not
adopted here. This project remains an Obsidian bridge for live-vault operations:
search, fetch, task management, periodic notes, frontmatter, linking, templates,
and other Obsidian-specific workflows.

## Consequences

Hosted ChatGPT setup has a stronger auth and connectivity boundary. Operators
now have two routes to reason about:

- local/private full MCP server for Claude and trusted local clients
- public/hosted ChatGPT facade for constrained connector access

The legacy in-process ChatGPT layer remains available for local/dev
compatibility, but documentation should recommend the facade for hosted
connector use.

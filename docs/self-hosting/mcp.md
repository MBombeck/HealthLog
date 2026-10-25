# MCP connector — enable and connect

HealthLog can expose **one user's own health record to an external
assistant** (Claude.ai, ChatGPT, Claude Desktop) through a Model Context
Protocol (MCP) server. The assistant reads your figures — vitals, sleep,
labs, medications, discovered drivers — and, if you opt in, can log a
self-reported reading back. Everything stays on your instance; the
assistant only sees what it asks for, one record at a time.

The surface is **off by default**. It does nothing until you (1) pin a
canonical origin, (2) turn the `mcp` module on for your account, and
(3) mint a token. A self-hoster who never opts in gets zero new exposure
— the `/mcp` endpoint answers `404` until all three are in place.

This guide covers turning it on and pointing a real client at it. For
what the server can do, see [the capabilities
reference](../api/mcp-capabilities.md); for building a connector or skill
on top of it, see [building skills](../api/mcp-skills.md).

> **Read this before enabling writes.** A remote, write-capable connector
> reached over OAuth is a powerful combination. Read the
> [trust model](#trust-model--read-this-before-enabling-writes) at the end
> of this page first.

## Prerequisites

Three things must be true before `/mcp` will answer:

| Requirement                | Why                                                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`APP_URL` is set**       | The endpoint fails closed without a pinned canonical origin. `APP_URL` (or `NEXT_PUBLIC_APP_URL`) is the origin every OAuth document and audience check is anchored to — `Host` is never trusted. Without it the surface stays invisible (`404`). |
| **The global API is on**   | The operator's instance-wide API switch must be enabled (it is by default). With it off, every token path — including `/mcp` — returns `404`.                                                                                                     |
| **The `mcp` module is on** | A per-account opt-in that ships off by default; you turn it on in **Settings → Modules**. Until then `/mcp` answers `404` for that account.                                                                                                       |

`APP_URL` is the same origin you already use for passkeys and invite
links — for example `https://health.example`. It must be reachable by the
client you are connecting (Claude.ai and ChatGPT connect from their own
servers, so the origin has to be a real public hostname for those; a
LAN-only origin works for Claude Desktop over stdio).

## 1. Enable the module

The switch lives with every other module: **Settings → Modules**, the
**MCP** row. Turn it on and the `/mcp` endpoint goes live for your account.

**Settings → MCP connector** is where you use it. The page has three parts:

- **State** — whether the module is on, with a link to its switch in
  Modules, and your endpoint URL (`<origin>/mcp`). Turning the module off
  pauses the endpoint; your tokens and connections stay and work again
  once it is back on.
- **Connections** — cloud connectors that completed the OAuth flow appear
  here; revoke any of them.
- **Tokens** — manual connector tokens (see below).

## 2. Mint a connector token

Still in **Settings → MCP connector → Tokens**:

1. Choose the scope with the **write** toggle:
   - **off** → a read-only token (`health:read`). This is the default and
     the right choice unless you actually want the assistant to log
     readings.
   - **on** → a read **and** write token (`health:read health:write`).
     The write scope only ever admits the three confirmed, append-only
     write tools (below) and is **bound to `/mcp`** — it can never write
     over the regular REST API.
2. Name the token and create it.
3. **Copy the `hlk_…` value now** — it is shown exactly once and cannot
   be retrieved again. Tokens default to a 90-day lifetime.

The token never carries the `*` wildcard and never a medication-ingest
scope — it is the least-privilege MCP scope and nothing more, and it is
bound to the MCP surface: it is refused on every REST route. The same
list shows last-used time and lets you revoke any token.

MCP reads now require an explicit MCP read capability. A token must carry
`health:read` (or the legacy/native `*` wildcard) before the server registers
or invokes any read tool. `health:write`, `fhir:read`,
`medication:ingest`, notification scopes, and every other unrelated scope do
not imply `health:read`; presenting one of those narrow tokens to `/mcp` is
rejected before health data is accessed. Likewise, `health:read` does not
grant a regular REST read or any write. When upgrading, check any manually
provisioned connector token and mint a replacement with `health:read` instead
of broadening an unrelated credential.

Cloud connectors that use OAuth (next section) mint the same
`health:read` scope automatically, so for Claude.ai / ChatGPT you do not
need to mint a token by hand — the manual token is for the stdio / power-
user path and for clients you wire up with a static Bearer.

## 3. Connect a client

The endpoint is `<APP_URL>/mcp` for every remote client. A non-browser
client (Claude.ai / ChatGPT server-side) sends no `Origin`, so it
connects directly; a browser `Origin` that does not match `APP_URL` is
refused (`403`) as a DNS-rebinding defence.

### Claude.ai (remote + OAuth)

1. In Claude.ai, add a custom connector and paste `<APP_URL>/mcp`.
2. Claude.ai discovers the OAuth flow automatically: the `401` from
   `/mcp` points at `/.well-known/oauth-protected-resource`, which names
   the authorization server, and the client walks `/authorize` →
   `/token`. PKCE (S256) is mandatory; the built-in bridge accepts
   client-id-metadata-document clients with dynamic registration as a
   fallback.
3. Approve the consent screen. The connection then appears under
   **Settings → MCP connector → Connections**, where you can revoke it.

No token to paste — OAuth mints and rotates a short-lived `health:read`
access token (60 minutes, with a refresh token) behind the scenes.

### ChatGPT (remote)

1. Add `<APP_URL>/mcp` as a connector. The same OAuth discovery applies.
2. In ChatGPT's **default** (non-Developer) mode, the only tools it will
   call are **`search`** and **`fetch`** — these are HealthLog's two-tool
   retrieval façade over the same server-authoritative reads. So in
   default ChatGPT you ask in natural language ("what's my recent LDL?",
   "when was my left knee operation?", "what does the discharge letter
   say?") and it searches your record and fetches the matching item with a
   citation deep-link back into the app. Search covers metrics,
   medications, lab values, visits and procedures, conditions, documents
   and vaccinations. Developer mode exposes the full tool catalogue.

### Claude Desktop (stdio)

Claude Desktop runs a local process and speaks the protocol over stdio —
no OAuth, no public hostname. Mint a token (step 2), then add an entry to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "healthlog": {
      "command": "pnpm",
      "args": ["dlx", "tsx", "src/cli/mcp-stdio.ts"],
      "cwd": "/path/to/HealthLog",
      "env": {
        "HEALTHLOG_MCP_TOKEN": "hlk_…",
        "DATABASE_URL": "postgres://…",
        "API_TOKEN_HMAC_KEY": "…",
        "ENCRYPTION_KEYS": "…"
      }
    }
  }
}
```

The stdio entrypoint reads the token from `HEALTHLOG_MCP_TOKEN`
(preferred — keeps the secret out of the process argument list) or as the
first CLI argument. With no token it refuses to start; running it with a
minted token **is** the opt-in. It needs database access, so it runs from
a checkout with the same `DATABASE_URL` / `API_TOKEN_HMAC_KEY` /
`ENCRYPTION_KEYS` your instance uses. Use `tsx` via `pnpm dlx` — the
production standalone image strips `tsx`, so this is a local-only tool.
stdout is the JSON-RPC channel; diagnostics go to stderr.

## Trust model — read this before enabling writes

The combination of a **remote** endpoint, **write** capability, and
**OAuth** access is exactly the high-leverage surface to be careful with.
HealthLog ships several structural limits, but the operator's choices
still matter:

- **Only enable the connector for clients you trust.** Anything that
  holds a valid token or a live OAuth connection reads your health
  record. Revoke connections and tokens you no longer use (Settings →
  MCP).
- **Use a read-only token unless you need writes.** The default. A
  read-only session never even sees the write tools advertised.
- **Writes are narrow by construction.** The only writes are
  append-only, confirmed inserts of a single self-reported reading
  (`log_measurement`, `log_mood`, `log_blood_pressure`). There is no
  medication, lab, schedule, delete, update, or data-export tool, and a
  `health:write` MCP token is refused on every REST write — it can never
  become a general write credential.
- **Admin is unreachable over MCP.** `requireAdmin()` is cookie-only and
  the MCP wire carries no cookie, so no token — not even a `*` wildcard —
  can reach an admin endpoint over this surface.

The structural guarantees are detailed in [the capabilities
reference](../api/mcp-capabilities.md#security-and-write-model).

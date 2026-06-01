# G-3 Security Review — v1.5.6 integration branch

Scope: `git diff d54addd6..release/v1.5.6` (egress hardening focus, plus
step-consolidation job + medication detail-page rewrite for new
SSRF/authz/injection surface). Threat model: motivated adversary against a
self-hosted production deployment. READ-ONLY review.

## Block release on:

- **Nothing is a hard release blocker.** The egress workstream is correct
  and the new surfaces (step consolidation, detail page) introduce no
  authz/injection regression. The two items below are defence-in-depth
  hardening that SHOULD land before tag but do not, on their own, open a
  remotely-reachable hole in the default deployment.
  - **M-1** — ESLint `/`-prefixed exemption accepts protocol-relative
    (`//evil.com`) and backslash (`/\evil.com`) absolute URLs. Lint-time
    guard only; tighten before relying on the rule as a real egress floor.
  - **M-2** — Avatar oversize-abort leaves the `formData()` parse promise
    dangling, so the original (attacker-controlled) body keeps buffering
    after the clone drain trips. Bounded by the 10/hour rate-limit; fix to
    actually free memory on abort.

---

## Critical

None.

## High

None.

## Medium

### M-1 — `safe-fetch-required` `/`-prefixed exemption smuggles absolute URLs
`eslint-plugins/healthlog/safe-fetch-required.js:108-120`

`isSameOriginRelative` returns true for any string literal / template head
that `.startsWith("/")`. Two absolute-URL forms slip through:

- `fetch("//evil.com/x")` — a protocol-relative URL. WHATWG URL parsing
  resolves `//host` against the page origin's scheme → `https://evil.com`.
  Starts with `/`, so the rule exempts it.
- `fetch("/\\evil.com")` (`/\evil.com`) — the URL parser normalises `\` to
  `/`, yielding `//evil.com` → `https://evil.com`. Also exempted.

Impact is bounded because this is an author-time lint rule, not a runtime
guard — a developer must deliberately write the smuggled form, and the
review/CI would still see the diff. But the rule is explicitly positioned
in `CLAUDE.md` as the egress floor ("banning raw `fetch(` outside the
wrapper"), and an exemption that lets an absolute external host through
defeats that purpose silently.

Fix: only exempt a single leading `/` that is NOT followed by `/` or `\`.

```js
function isSameOriginRelative(arg) {
  const head =
    arg?.type === "Literal" && typeof arg.value === "string"
      ? arg.value
      : arg?.type === "TemplateLiteral" && arg.quasis.length > 0
        ? (arg.quasis[0].value.cooked ?? "")
        : null;
  if (head === null) return false;
  // Single leading slash only — reject `//host` and `/\host` (both
  // resolve to an absolute external origin).
  return /^\/(?![/\\])/.test(head);
}
```

A template head of exactly `"/"` (one char, e.g. `` fetch(`/${path}`) ``)
would now be flagged; that is acceptable — a variable-built path head is
exactly the case that warrants the wrapper or an explicit eslint-disable.

### M-2 — Avatar oversize-abort does not cancel the `formData()` parse; memory not freed on abort
`src/app/api/user/avatar/route.ts:147-169`

The stream cap drains `request.clone().body` (the tee) in parallel with
`request.formData()` on the original. When the clone drain throws
`BodyTooLargeError`, `Promise.all` rejects and the handler returns 413
immediately at line 156-162 — but it does NOT await or cancel
`parsePromise`. The native `formData()` parse on the ORIGINAL request keeps
running in the background and continues buffering the full
attacker-controlled body into memory (the very thing the stream cap was
added to prevent). The clone branch stops early; the original does not.

Contrast with the non-overflow error branch (line 164), which correctly
does `await parsePromise.catch(() => {})`.

The "frees memory on abort" property therefore does not hold for the
overflow path. Real-world blast radius is limited by the per-user
10/hour/`user.id` rate-limit (line 108, runs before any body read) and the
2 MiB cap meaning a single trip only over-buffers one oversized body per
slot — but a malicious authenticated client can still drive 10 large
in-flight buffers/hour, each of which lingers until the dangling parse
settles or the request lifecycle tears the socket down.

Fix: do not leave the parse floating. On `BodyTooLargeError`, abort/settle
it before returning, e.g. attach `parsePromise.catch(() => {})` so the
rejection is observed, and prefer aborting the underlying request. Simplest
robust shape: drive both off a single `AbortController` and abort the
parse when the cap trips, or read the body ONCE through the bounded reader
and reconstruct `FormData` from the captured bytes rather than tee-ing.

```ts
if (err instanceof BodyTooLargeError) {
  // Observe the dangling parse so the original body stops buffering
  // into an unobserved rejection / lingering allocation.
  void parsePromise.catch(() => {});
  annotate({ /* … */ });
  return apiError(`Upload exceeds ${AVATAR_MAX_BYTES} byte limit`, 413);
}
```

(The `void parsePromise.catch` only prevents an unhandled-rejection; it
does not stop the buffering. The structural fix is a shared AbortController
so the trip actually cancels the parse — recommended.)

## Low

### L-1 — Codex SSE timeout raised to 60 s without a response-body read budget
`src/lib/ai/codex-client.ts:284-326`

The migration correctly bumps `timeoutMs` to 60 000 to match the other AI
clients so a long generation is not clipped, and inherits `redirect:
"manual"` from the wrapper default (good — the OAuth bearer no longer
leaks on a redirect hop). Note only: the 60 s budget bounds the
connect+headers, but a streaming SSE body can still hold the socket past
the timeout once headers have arrived (the timeout signal fires on the
fetch, not the per-chunk read loop). This matches the pre-existing
behaviour of the other AI clients, so it is not a regression — flagged for
completeness only.

## Informational

### I-1 — Credential-carrying constant-host migrations: verified correct
`src/lib/withings/client.ts` (5 calls: exchangeCode, refreshAccessToken,
fetchMeasurements, subscribeWebhook, unsubscribeWebhook),
`src/lib/withings/sync-activity.ts:149`, `src/lib/withings/sync-sleep.ts:119`,
`src/lib/ai/codex-oauth.ts` (4 calls), `src/app/api/bugreport/route.ts:162`.

All now route through `safeFetch`, which pins `redirect: "manual"` by
default. The Withings token bodies (`client_secret`, refresh/access
tokens), the Codex OAuth client-secret/PKCE/refresh bodies, and the GitHub
PAT (`Authorization` header on the bugreport comment POST) can no longer be
replayed onto a redirected hop. None of these set `followRedirects`, so the
manual-redirect default holds. Constant hosts → no `requirePublicHost`
needed (no rebinding surface), consistent with the wrapper docstring.

### I-2 — Operator-supplied-host migrations: `requirePublicHost` set everywhere expected
`src/app/api/monitoring/umami-script/route.ts:30`,
`src/app/api/admin/monitoring/umami-test/route.ts:92-105`,
`src/app/api/send/route.ts:77-91`,
`src/lib/monitoring/glitchtip.ts:126/161/191` (envelope + store-query +
store-header, all 3),
`src/lib/logging/transports.ts:75` (Loki).

Every operator-host call sets `requirePublicHost: true`, which both runs
the input-time `isPublicUrl` floor and routes through
`getPinnedPublicDispatcher()` (connect-time IP pin against DNS rebinding,
`src/lib/safe-fetch-dispatcher.ts`). The dispatcher fails closed
(`ENOTFOUND`) when no resolved address passes `isPublicIp`. Count matches
the workstream spec (umami-script, send, umami-test, glitchtip ×3, Loki).

### I-3 — ESLint rule wiring + residual raw-fetch sweep: clean
`eslint.config.mjs:34-41`, `eslint-plugins/healthlog/index.js`.

`healthlog/safe-fetch-required` is registered as `"error"`. A full sweep of
`src/lib` + `src/app` for raw `fetch(` found only: the wrapper's own call
(`src/lib/safe-fetch.ts:135`, exempt), and same-origin `/`-relative client
fetches (`src/app/insights/medikamente/page.tsx:93,267`,
`src/app/medications/[id]/page.tsx:153,170`,
`src/app/medications/[id]/history/page.tsx:37`) — all legitimately exempt
(modulo M-1's exemption-tightening). No external-host raw fetch remains.

### I-4 — Step-consolidation job + library: owner-scoped, injection-free
`src/lib/jobs/step-consolidation.ts`,
`src/lib/measurements/consolidate-legacy-steps.ts`,
`prisma/migrations/0087_v156_step_consolidation/migration.sql`.

The pg-boss job's discovery `$queryRaw` (step-consolidation.ts:95) is a
tagged template with a compile-time-constant `stats:` prefix literal — no
splice, no user input. It enqueues one payload per internally-discovered
`userId` (never body-supplied). The worker and the library
(`consolidateLegacySteps`) scope every `findMany` / `upsert` / `updateMany`
to `userId: user.id`; the soft-delete `updateMany` is keyed
`{ id: { in: ids }, deletedAt: null }` where `ids` came from the same
user-scoped read. No cross-tenant path. Migration 0087 adds a partial index
only — no data movement, no new column accepting external input.

### I-5 — Medication detail-page rewrite: read-only, no new endpoint
`src/app/medications/[id]/page.tsx`,
`src/app/medications/[id]/history/page.tsx`, plus the
`src/components/medications/*` and `settings/sections/*` changes.

The detail page is now a pure history surface; its only network calls are
GET fetches to existing same-origin endpoints (`/api/medications/${id}`,
`/api/medications/${id}/intake`, `/api/medications/${id}/compliance`). No
new API route, no mutating handler, no body-supplied `userId`, and ownership
continues to be enforced by the existing `assertMedicationOwnership` on the
backing `[id]` routes (unchanged in this diff). No new authz surface.

### I-6 — Avatar route authz + validation otherwise intact
`src/app/api/user/avatar/route.ts`.

`requireAuth()` first, per-user rate-limit before body read, owner-scoped
`prisma.user.update({ where: { id: user.id } })`, magic-byte MIME sniff
(wire Content-Type treated as informational), dimension cap, and the
post-parse `file.size` check as defence-in-depth. The only gap is M-2's
abort-cleanup; the validation chain itself is sound.

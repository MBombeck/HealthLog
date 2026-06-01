# F-2 Security Audit — v1.5.5 diff (`bf6dfb8f..HEAD`, 16 commits)

Audit scope: every commit since `3b7c72e1` (v1.5.4). Threat model: motivated
adversary against a self-hosted production deployment. Findings are pinned to
file:line and the commit that introduced them.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 6 |
| Low | 6 |
| Informational | 4 |

---

## Critical

None. The avatar pipeline, the `safeFetch` wrapper, the DNS-rebinding
dispatcher, and the medication-ownership sweep all hold up under direct
attack. The remaining findings degrade defence-in-depth rather than open a
breach path.

---

## High

None.

---

## Medium

### M-1 — `safeFetch` migration is incomplete on three hard-coded-host call sites that carry credentials

Commit `425503e0` claimed "14 outbound call sites migrated. The four that
already pinned manual redirect (the historic templates) keep their
semantics; the wrapper preserves an explicit `init.redirect`." That accounting
misses three callers that ship secrets on the wire and have neither
`redirect: "manual"` nor a timeout:

- `src/lib/withings/client.ts:112,155,272,349,400` — every Withings call sits
  on raw `fetch` with the OAuth `client_secret` (line 105) or the user's
  `access_token` in the body. A 302 from `wbsapi.withings.net` would leak
  those headers on the redirected hop, and a slow upstream pins the
  worker indefinitely. The host is hardcoded and Withings does not redirect
  today, so the active risk is "future Withings change" + tar-pit; both
  classes are what the wrapper exists to defeat.
- `src/lib/withings/sync-sleep.ts:121` and `src/lib/withings/sync-activity.ts:151`
  — same pattern, same headers, same gap.
- `src/lib/ai/codex-client.ts:286` — POST to `CODEX_ENDPOINT` with the user's
  Codex `Bearer ${accessToken}` and account id, no manual redirect, no
  timeout. Same risk profile as the Withings calls.
- `src/lib/ai/codex-oauth.ts:176,217,243,279` — four raw `fetch` calls during
  the Codex device-OAuth dance, no manual redirect, no timeout. These carry
  the device-code and the OAuth `code_verifier`, both of which a redirect-
  follow would forward.
- `src/app/api/bugreport/route.ts:162` — `await fetch(...)` to GitHub's API
  with `Authorization: Bearer ${ghToken}` on the screenshot-comment path.
  The route migrated the issue-creation call on line 124 to `safeFetch`
  but left the comment call as raw `fetch`.

Action: route each through `safeFetch` so the convention is enforced
everywhere a secret rides outbound. The wrapper preserves an explicit
`init.redirect` so a caller that genuinely needs to follow stays free to
opt in.

### M-2 — `safeFetch` callers with operator-supplied hosts skip `requirePublicHost`, leaving the DNS-rebinding pin off

Commit `b43b57f6` wired the pinned dispatcher behind the `requirePublicHost`
flag and the body of that commit lists "five outbound paths that accept a
user-supplied host". The audit found five more that accept an
**operator-supplied** host and skip the flag:

- `src/app/api/monitoring/umami-script/route.ts:29` — unauthenticated GET
  that proxies `settings.umamiScriptUrl` (admin-configured) and returns the
  body as `application/javascript` to every browser. A misconfigured admin
  + a low-TTL DNS record could route the fetch at an internal HTTP service
  whose response body is then served as JS on the HealthLog origin.
- `src/app/api/send/route.ts:77` and
  `src/app/api/admin/monitoring/umami-test/route.ts:92` — operator-configured
  Umami URLs. `isPublicUrl` runs at URL construction (good), but the
  connect-time pin from issue #217 is bypassed.
- `src/lib/monitoring/glitchtip.ts:126,155,180` — operator-configured
  GlitchTip envelope/store URLs. The host is operator trust, but a rebinding
  attack against a misconfigured DNS could land the report (which carries
  the redacted-but-still-sensitive wide-event payload) at an internal IP.
- `src/lib/logging/transports.ts:68` — operator-configured Loki endpoint.
  Same trust shape as GlitchTip.

Action: add `requirePublicHost: true` to every `safeFetch` call whose target
URL is sourced from an operator setting or env var. The five user-supplied
paths in `b43b57f6` are correctly flagged; this finding only extends the
convention.

### M-3 — Avatar upload buffers a chunked body up to the 2 MiB cap with no `Content-Length` pre-flight

`src/app/api/user/avatar/route.ts:85-95` pre-flights the declared
`Content-Length` and bails with 413 when it exceeds `AVATAR_MAX_BYTES`. The
guard only fires when the client sends a `Content-Length` header. A
`Transfer-Encoding: chunked` upload (or any request without the header) skips
the pre-flight; the code then calls `await request.formData()` at line 99,
which buffers the entire stream before the post-parse `file.size > AVATAR_MAX_BYTES`
check at line 112 can fire. Per-user rate limit (10/hour) caps the abuse,
but each request still allocates up to the cap before the size check runs.

Action: enforce the cap at the stream level. Next.js App Router doesn't
expose a `bodyParser.sizeLimit` for route handlers; the practical mitigation
is to read the body as a streamed `ReadableStream`, accumulate into a bounded
buffer, and abort on the first byte past `AVATAR_MAX_BYTES`. Alternatively
gate the route through a request-size guard in `proxy.ts` for the avatar
path.

### M-4 — `requireAuth` runs after the rate-limit lookup in the avatar POST, so an unauthenticated caller cannot trip the per-user limit

`src/app/api/user/avatar/route.ts:66-72` resolves the session, then keys the
rate limit on `user-avatar-upload:${user.id}`. An unauthenticated POST 401s
inside `requireAuth()` long before the limiter sees it — which is correct.
However, a Bearer token with `["*"]` scope can churn the limit at 10/hour,
and the limit is the only stop between an authenticated client and 10
`prisma.user.update` writes per hour. The cap is acceptable for a user-
action surface but worth pinning that an automation hitting `["*"]` could
park 10 writes per user per hour indefinitely. No action required if the
maintainer accepts the trade-off; flagging so the rate-limit budget stays
explicit.

### M-5 — `isPublicIp` does not reject IPv4 multicast / broadcast or IPv6 multicast / documentation ranges

`src/lib/validations/notifications.ts:81-130` covers loopback, RFC1918,
CGNAT, link-local, ULA, IPv4-mapped IPv6, and the unspecified address. It
does not reject:

- `224.0.0.0/4` (multicast) and `255.255.255.255` (broadcast) on IPv4.
- `ff00::/8` (multicast) and `2001:db8::/32` (documentation) on IPv6.
- `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` (TEST-NET-1/2/3).

A legitimate DNS resolver wouldn't return these, but a hostile resolver
could — and the connect-time pin is exactly the layer that's supposed to
catch hostile resolvers. Adding these to `isPrivateIpv4` and to the IPv6
prefix check on lines 94-124 closes the gap with a few extra lines.

### M-6 — Avatar GET uses persisted `Content-Type` directly, but does not pin `X-Content-Type-Options: nosniff` or `Content-Disposition: inline`

`src/app/api/user/avatar/[id]/route.ts:72-79` echoes the persisted
`Content-Type` (whitelisted on the write path — JPEG / PNG / WebP only) and
sets `Cache-Control: private, max-age=31536000, immutable`. The serve path
is owner-scoped (the 403 leak shape on a foreign id is correct). The
defence-in-depth gap: no `X-Content-Type-Options: nosniff`, no
`Content-Disposition: inline; filename="avatar"`. A browser that decides to
sniff (none currently do for binary image types served same-origin, but a
future change might) could mis-handle a crafted image. Adding both headers
costs two lines.

---

## Low

### L-1 — Parent medication GET still hand-rolls the ownership pattern

`src/app/api/medications/[id]/route.ts:25-57` still uses the
`findUnique` + `medication.userId !== user.id ? 404` pattern instead of the
shared `assertMedicationOwnership`. The PUT (line 69) and DELETE (line 280)
were migrated by commit `af224964`; the GET was not. Result is identical for
the caller (404 on either branch), but the codepath leaks an extra
`schedules` include and the 404 message lives outside the helper that the
audit commit named as the single source of truth.

### L-2 — GLP1 GET still hand-rolls the ownership check

`src/app/api/medications/[id]/glp1/route.ts:44-61` uses
`findUnique({ include: ... })` and then `medication.userId !== user.id`.
The route's POST (line 127) was already on the helper. Same gap as L-1,
same fix.

### L-3 — Insights-layout PUT echoes the redacted payload diagnostic but does not redact the layout JSON itself

`src/app/api/insights/layout/route.ts:97` builds a payload diagnostic from
`redactSensitiveFields(body)`. The layout body carries no secrets by
construction (tile ids + booleans + ints), but the redactor runs against the
whole body and may add CPU per failed validation. Not a security gap; an
operator who later adds a sensitive field to the layout schema should
re-verify the redactor's denylist covers it.

### L-4 — Bulk-delete intake endpoint has no per-IP / per-user rate limit

`src/app/api/medications/[id]/intake/bulk-delete/route.ts:49` runs without
a rate-limit gate. The Zod cap (500 ids) bounds a single request, but an
attacker with a session can churn 500-row deletes back-to-back. Each call
also kicks `recomputeMedicationComplianceForDay` per affected dayKey. The
ownership guard means the deletes only touch the attacker's own data, so
the damage is self-inflicted; the rollup recompute is the operator-side
cost. Worth a `medications.intake.bulk-delete:${user.id}` rate-limit
bucket.

### L-5 — Avatar upload audits the byte size + width + height into the audit ledger

`src/app/api/user/avatar/route.ts:187-196` writes the upload size and
dimensions into the audit row's `details`. These are not user-controlled
strings, so no injection; but a privacy-conscious operator might prefer to
keep image dimensions out of the audit trail. Informational at most;
flagging because the prior audit baseline (.planning/security-audit-v1.5.2.md)
explicitly narrows audit `details` to "the smallest identifier that lets
operators reconstruct the action".

### L-6 — Series-cap raise opens a 10-year read window with no row-count guard

`src/app/api/measurements/series/route.ts:55` raises the `days` cap from
365 to 3650. The Apple Health step path on a power-user account can land
hundreds of thousands of rows in that window. The endpoint runs
`prisma.measurement.findMany` with no `take` and the trend summarizer walks
every row. The cold-fallback pattern from v1.4.34 was supposed to land a
hard row-count budget on every long-window read; this route shipped without
one. Per-user, owner-scoped, but a single iOS client repeatedly opening
the "Alle" range can pin a Prisma pool slot for the duration of the read.

---

## Informational

### I-1 — `Cache-Control: private, max-age=31536000, immutable` on the avatar GET relies on the URL's `?v={updatedAtMs}` to bust on re-upload

`src/app/api/user/avatar/[id]/route.ts:77`. The contract holds — the /me
payload appends the suffix at `src/lib/avatar.ts:217` — but a future
refactor that returns the bare `/api/user/avatar/{id}` URL would silently
serve a year-stale avatar. The contract should be tested at the integration
layer to lock it in. Probably already covered by
`tests/integration/user-avatar.test.ts`; flagging for re-verification.

### I-2 — `pinnedLookup` uses `dns.lookup` which consults `nsswitch` / `/etc/hosts`

`src/lib/safe-fetch-dispatcher.ts:55`. An operator that adds a hostname →
private-IP mapping in `/etc/hosts` will have that mapping refused by the
dispatcher (correct behaviour). But the same operator's `/etc/hosts`
entries override the resolver entirely, including the legitimate Withings
or AI provider entries. Document in `docs/ops/` that
`safeFetch` + `requirePublicHost` refuses any host listed in `/etc/hosts`
to point at an RFC1918 address.

### I-3 — `safeFetch` is opt-in; no lint rule or CI grep flags raw `fetch(` outside the wrapper

`src/lib/safe-fetch.ts` is the documented egress entry, but the project's
ESLint config and knip gate do not flag raw `fetch(` calls. The audit
counted 17 raw `fetch(` calls in `src/lib/` + `src/app/api/` (M-1 lists
the ones that carry secrets). A future maintainer landing a new outbound
call has nothing structural reminding them to route through the wrapper.

Action: add a project-local ESLint rule
(`healthlog/safe-fetch-required` or equivalent) that bans
`fetch` outside `src/lib/safe-fetch.ts` and the test helpers. Update
`CLAUDE.md` § "Security-relevant patterns" with the convention.

### I-4 — `Bytes` Prisma column serialised through `new Uint8Array(N).set(buffer)` to satisfy `ArrayBuffer`-backed type

`src/app/api/user/avatar/route.ts:170-178`. The comment explains the cast
correctly. Worth a follow-up to verify that Prisma 7.x's `Bytes` column
type round-trips a > 0 byte buffer without copy on the `findUnique`
read-back path; if the read also clones the buffer the per-request cost is
2× the file size. Performance, not security; flagging for the perf budget.

---

## Migration safety

All four v1.5.5 migrations (`0083_v155_ios_measurement_types`,
`0084_v155_user_insights_layout`, `0085_v155_user_avatar`,
`0086_v155_ios_walking_step_length_speed`) are additive: enum extensions
plus nullable column adds. No `NOT NULL` without a default; no constraint
that an existing row could break. Safe to apply on a live deployment.

---

## Audit-log / wide-event redaction

The new sensitive surfaces — avatar bytes, insights layout JSON, the detail-
page actions — each route their audit / wide-event paths through the
existing redactor (`redactSensitiveFields` + `buildPayloadDiagnostic` for
the insights PUT, `auditLog` with narrow `details` for the avatar paths).
No new field carries user-controlled free-text into the audit envelope.
The series route's audit row strips `message` from Zod issues via
`sanitiseZodIssues(..., { stripValuesFromMessage: true })` (line 119) — same
pattern the v1.4.49 hardening established.

---

## Cross-tenant exposure

Spot-checked every `/api/medications/[id]/**` sub-route. Ownership coverage:

| Route | Method | Ownership |
|---|---|---|
| `/api/medications/[id]` | GET | hand-rolled (L-1) |
| `/api/medications/[id]` | PUT | helper (post-`af224964`) |
| `/api/medications/[id]` | DELETE | helper (post-`af224964`) |
| `/api/medications/[id]/api-endpoint` | GET / POST | helper |
| `/api/medications/[id]/cadence` | * | helper |
| `/api/medications/[id]/compliance` | GET | helper |
| `/api/medications/[id]/glp1` | GET | hand-rolled (L-2) |
| `/api/medications/[id]/glp1` | POST | helper |
| `/api/medications/[id]/intake` | GET / POST | helper |
| `/api/medications/[id]/intake/[eventId]` | * | hand-rolled (`event.userId !== user.id`); narrow on event + medication, structurally correct |
| `/api/medications/[id]/intake/bulk-delete` | POST | helper |
| `/api/medications/[id]/intake/import` | POST | helper (post-`af224964`) |
| `/api/medications/[id]/intake/purge` | DELETE | helper (post-`af224964`) |
| `/api/medications/[id]/inventory` | * | helper |
| `/api/medications/[id]/inventory/[itemId]` | * | hand-rolled (`item.userId !== userId`); narrow on item + medication, structurally correct |
| `/api/medications/[id]/phase-config` | * | helper |
| `/api/medications/[id]/side-effects` | * | helper |
| `/api/medications/[id]/side-effects/[logId]` | * | hand-rolled (`row.userId !== userId`); narrow on row + medication, structurally correct |
| `/api/medications/[id]/titration` | * | helper |

Cross-tenant reads via Bearer token: none found. Every route narrows the
Prisma `where` clause on `userId` from the resolved session.

---

## CSP

`src/proxy.ts:268-275` removes Gravatar from the production CSP and lands
on `img-src 'self' data:`. The same-origin avatar at
`/api/user/avatar/{id}` fits without widening the directive. No new host
in `connect-src`. Strict CSP preserved.

---

## Forward-compat recommendation

The most durable improvement is I-3: a project-local ESLint rule that
flags raw `fetch(` outside the wrapper. The v1.5.5 audit found six call
sites that the wrapper migration missed (M-1 + M-2). A structural gate is
cheaper than a re-audit each release.

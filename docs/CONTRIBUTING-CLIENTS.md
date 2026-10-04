# Building a native client against HealthLog

Working notes for anyone building a client app (Android, iOS, CLI, anything else) against the HealthLog server, with or without AI tooling. Everything in here is a rule we actually follow between the server and the iOS app, written down so a second client does not have to rediscover it. Pair it with `CLAUDE.md` (server-side conventions) and `docs/api/openapi.yaml` (the wire contract).

## The contract, and where truth lives

- `docs/api/openapi.yaml` is the single source of truth for the API. It is generated from the server's Zod schemas and CI fails on drift, so what the YAML says is what the server does. Build your models from it rather than from observed responses.
- The contract you target is the one in a tagged release (`vX.Y.Z`), not whatever is on `main` between releases. A running server tells you its version at `GET /api/version` (`version`, `buildSha`, `builtAt`).
- Contract changes are additive. Fields get added, routes get added; existing consumers keep reading what they read before. When a route is retired it does not vanish: it answers `410` with a machine-readable `meta.errorCode`, so a client can tell "removed on purpose" from "you have a bug".
- If you need something the API does not carry, ask for it in an issue before building a workaround. Adding a route or a field on the server is usually cheaper than a client-side reconstruction, and a workaround becomes a compatibility burden for both sides the moment it ships.

## The envelope

Every JSON route answers the same shape: `{ data, error }`, with `meta` on the error path when there is something machine-readable to say. Success means `data` is set and `error` is `null`. Validation failures answer `422` and carry every issue at once, not just the first, so a form can annotate all fields in one round trip. Parse the envelope first, then the payload; never assume a `200` body is the payload directly.

## Auth, from a client's point of view

- Password, passkey, and an OIDC handoff exist for sign-in. The native OIDC flow hands the app a one-time code via a fixed URL scheme; tokens never ride a URL.
- Refresh tokens rotate per device and are one-time-use. Reusing an old one revokes that device's whole token family, on purpose. Persist the newest pair atomically and never retry a refresh with a token that already succeeded once.
- Bearer token scopes are fail-closed. A token minted for one purpose does not open unrelated routes, and a route that does not declare a scope refuses narrow tokens outright. Expect `403` to be a normal, recoverable answer, not an anomaly.
- Admin surfaces are cookie-session only, by construction. A native client cannot be an admin client, whatever scopes its token carries. Do not build admin features.
- Mutations accept an `Idempotency-Key` header. A repeat of the same key with the same body answers with the original result plus `X-Idempotent-Replay`, so retrying on a dropped connection is safe. A different body under the same key is treated as a new request, not a replay; still, give each distinct write its own key. Use it for anything a user would notice twice.

## Data semantics worth knowing before you sync

- Batch measurement ingest treats `externalId` as the dedupe handle. Ids with the `stats:` prefix are overwrites (a re-post replaces the row), every other id is first-write-wins immutable. The per-entry response says which happened (`inserted` vs `updated`). Design your sync around that difference rather than around client-side bookkeeping.
- Absence is explicit. A metric that answers "not present" means the record honestly has nothing there. It is not zero, not an error, and not a reason to fill the gap client-side.
- Modules can be switched off per account. Routes belonging to a disabled module answer `403`; render that as "this feature is off", not as a failure.
- Whatever the user typed stays verbatim. Names of custom metrics, notes, labels: the server returns the user's own text and does not translate or normalise it. Curated content, on the other hand, comes with stable keys a client can localise.

## Server-authoritative values

The strongest rule we have, learned the slow way: when the server computes something (a compliance rate, a health-score verdict, a reference-range judgement, an aggregation bucket), the client renders the resolved value from the payload. It does not re-derive the number from raw data, because two implementations of one formula will disagree eventually, and the user sees two apps arguing about their own health record.

The corollary: if a resolved value you need is missing from a payload, the fix is to ask the server to carry it, never to reimplement the server's logic in the client. And when the server changes a resolved value's meaning, that is a contract change and gets announced, not slipped in.

## How coordination works in practice

- One issue per question or contract need, opened early, ideally before you build on an assumption. A wrong assumption caught in an issue costs a comment; caught after a release it costs a migration.
- Claims about behaviour are made against a running instance, with the route and status code, not from reading code. "The code looks like it should" has burned us; "I called it and got this" has not.
- Answers you get from the server side name file and line or route and measurement, so you can verify them instead of trusting them. Hold your own reports to the same bar and it stays pleasant.
- Release notes and the changelog say when something client-relevant shipped. Reconcile open questions against each release rather than assuming the answer is still pending.

## Ground rules for the repo itself

The voice-and-privacy rules from `CLAUDE.md` apply to any repo under the project, including a client repo: commit messages and public text carry no tooling attribution and no assistant vocabulary, no real names of users or reporters, and no live health figures, ever. Fixtures use invented data. If an AI tool wrote part of a change, the human who commits it has read it and stands behind it; the git history knows only authors.

Secrets never appear in code, fixtures, or examples, not even placeholder-shaped real ones. Anything user-identifying stays out of logs on the client just as it does on the server.

## What a client should not do

- No scraping of web routes or HTML pages; the JSON API is the interface.
- No admin endpoints, see above.
- No CORS assumptions: the server serves same-origin browsers and header-authenticated APIs, nothing else.
- No silent behavioural drift from the web app. Where the web app and a native client both render the same concept, they should mean the same thing; when they cannot, that difference is documented in an issue, not discovered by users.

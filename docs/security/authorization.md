# Authorization

What an authenticated caller may reach, decided on the server for every
request. The detailed product rules of sharing live in
[`self-hosting/account-sharing.md`](../self-hosting/account-sharing.md); this
page is the model those rules sit in. How a caller proves who they are is in
[authentication](authentication.md).

## Rules that hold everywhere

- **The account comes from the credential.** A route reads the caller from the
  session cookie or the Bearer token (`requireAuth`, `src/lib/auth/guards/`)
  and narrows every query by that id. No route takes a `userId` from a body or
  a query string; the batch endpoints do not even declare one.
- **The guard is chosen, never defaulted open.** Every route under `src/app/api`
  calls one of the guards below or is on a listed exception
  (`src/__tests__/auth-guards-entry-guard.test.ts`).
- **Refusals are uniform.** A record, section or entry the caller may not
  reach is answered exactly like one that does not exist.
- **Client checks are presentation only.** The UI reads what the server
  resolved (`/api/auth/me`: role, modules, AI capability, the open record and
  its grant) and never decides access itself.

## Roles

There are two: `USER` and `ADMIN`.

- The first account on an instance is `ADMIN`
  ([first account](authentication.md#first-account)); after that only an admin
  changes a role, through `PUT /api/admin/users/[id]`. An instance always keeps
  one admin who can sign in: demoting or deleting the last one is refused.
- `requireAdmin()` resolves the caller from the session cookie only. A Bearer
  token, a wildcard one included, never reaches an admin route, and opening
  another account's record never confers that account's role
  (`src/lib/auth/guards/cookie.ts`).
- There is no admin view of another account's health record in the app. An
  admin administers accounts (create, change identity and role, require a
  second factor, delete, reset a password, sign out) and the instance
  (settings, keys, backups). Instance backups hold every account's data; their
  download, upload and restore need a fresh proof and are audited. Anyone with
  database or host access can read the database directly; that is a property
  of self-hosting, not of a role.

## Transports and scopes

| Credential                                          | Reaches                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web session (cookie)                                | everything the account may reach, including the cookie-only surfaces: admin routes, second-factor management, managed-profile creation, offering a manage grant                                                                                                 |
| Wildcard token `["*"]` (the iOS app's access token) | what a cookie session reaches, except the cookie-only surfaces                                                                                                                                                                                                  |
| Narrow token                                        | only routes that name its scope: `measurements:write`, `workouts:write`, `documents:write`, `fhir:read`, the per-medication ingest pair (`medication:ingest`, `medication:<id>:ingest`). Everything else answers 403 and writes an `undeclared_scope` audit row |
| MCP token (`health:read`, `health:write`)           | only `/mcp`. A `health:write` token is bound to `/mcp` and refused on every REST write; it admits only the MCP write tools, each confirmed by the user                                                                                                          |

Bearer scope is fail-closed: `requireAuth()` without an argument admits a
cookie session or a wildcard token and nothing narrower, so a new route cannot
widen an existing token by accident. Only the sign-in, passkey and refresh
paths mint a wildcard token. Frozen by
`src/__tests__/bearer-scope-enforcement-guard.test.ts`, which also pins the
three places that read a Bearer header outside `requireAuth`. No route mints
`fhir:read` today; the FHIR read face accepts it for a future mint and accepts
cookie and wildcard callers now.

## Another person's record

Two arrangements let one account act in another account's record; both are
grants between accounts on the same instance.

**Sharing grants.** An owner invites another account at one of three levels,
optionally narrowed to named sections (readings, medications, labs, health
background, illness, mood and mind, cycle, documents):

| Level  | Inside what the grant opens                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| Read   | read                                                                                                           |
| Write  | read, and add entries (not edit, delete or restore them)                                                       |
| Manage | always the whole record: read, add, change and remove entries, record the health background, read the insights |

Nothing about the account around the record is reachable at any level:
credentials, sessions, tokens, integrations, notification channels, full
exports, share links, AI requests, sharing itself
([the full list](../self-hosting/account-sharing.md#what-the-other-person-can-and-cannot-do)).

**Managed profiles.** A record for somebody with no login. Its guardians hold a
manage grant over the whole record and, with it, everything the profile's owner
could do, by one rule rather than a list of features. The exceptions are the
guardian's own identity (passkeys, second factor, sessions, password, email,
API and MCP tokens, the push registration of their device), deleting or
erasing an account and deciding who may open it (both done from the guardian's
own account under the profile's card), and the handover decision that belongs
to the person once they have a login
([details](../self-hosting/account-sharing.md#records-with-no-login)).

**How it is enforced.** A request that acts in another record carries the
record in a header and is resolved by `requireRecordAuth` (and
`requireGuardianAuth` for guardian-only acts), which checks the grant, its
level and its sections on every request. Plain `requireAuth()` is the owner
rule: it serves a managed profile to its guardian (a manage grant over the
whole record on a record with the managed-profile marker) and refuses every
other request that carries such a header, with 403 `sharing.not_permitted`, so
a route that never declared how it behaves under a grant cannot silently answer
an adult's delegate with the wrong person's data. A route that must stay the
caller's own under every switch resolves with `requireSelfAuth()` and is listed,
with its reason, in `managed-profile-owner-rule-guard.test.ts`. Every act a delegate performs is written to the
owner's trail under the delegate's name; delegated reads are counted per day.
Guards: `acting-account-boundary-guard.test.ts`, `sharing-surface-guard.test.ts`,
`managed-profile-owner-rule-guard.test.ts`,
`record-session-fence-guard.test.ts`, `module-gate-record-scoped.test.ts`.

**URL credentials.** A clinician share link, an emergency card link and the
calendar feeds each open a fixed, read-only selection of one record to
whoever holds the link ([the list](authentication.md#url-credentials)). They
are created only by the owner (or a guardian, for a managed profile), behind a
fresh proof, and are revocable.

## Modules and AI

- **Modules.** A module the owner turned off (or the operator made
  unavailable) is refused on its routes for every caller, delegates included;
  `src/lib/modules/surface.ts` maps each surface to its module.
- **AI.** An AI capability gates model work and model-written text, never data.
  It is resolved once per request on the server
  (`src/lib/ai/capabilities/`), re-checked right before anything is sent to a
  provider, and published to clients, which only render it. AI requests
  always run under the record owner's consent; a delegate cannot ask an AI
  provider anything about somebody else's record. Guards:
  `src/app/api/__tests__/ai-capability-route-inventory.test.ts`,
  `src/__tests__/ai-egress-capability-guard.test.ts`.

## Field-level rules

| Field or data                                                        | Read                                                                                                                                                                   | Write                                                                                                                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role`, per-account second-factor requirement, document quota        | the account itself, admins                                                                                                                                             | admins only (`PUT /api/admin/users/[id]`); not in any profile schema                                                                              |
| Username, e-mail                                                     | the account itself, admins                                                                                                                                             | the account itself, an e-mail change behind the password or a second factor from the last five minutes (`src/lib/auth/profile-update.ts`); admins |
| Password, passkeys, second factors, recovery codes, sessions, tokens | the account itself (lists, never secret values)                                                                                                                        | the account itself, cookie session, fresh factor; admin password reset                                                                            |
| Health record entries                                                | the owner; delegates per level and section                                                                                                                             | the owner; delegates at write (add) and manage (change, remove)                                                                                   |
| Record settings (modules, units, thresholds, language, timezone)     | the owner; guardians of a managed profile                                                                                                                              | the owner; guardians of a managed profile                                                                                                         |
| Insurance fields, full legal name, date of birth                     | the owner (and guardians); never in the page seed, only in the `/api/auth/me` read                                                                                     | the owner (and guardians)                                                                                                                         |
| Anything not named in an allowlist                                   | not sent: the page seed copies only `ACCOUNT_SEED_FIELDS` (`src/lib/auth/account-seed.ts`), responses select explicit fields (`session-user-projection-guard.test.ts`) | not written: every Prisma `create` and `update` builds its data field by field from the parsed body, never by spreading it                        |

Inside a section a grant opens there is no row or field filtering: a grant to
"Readings" shows every reading and its note.

## Function by role

| Function                                                 | Owner, browser | Owner, app                                                                      | Narrow token | MCP             | Delegate read | Delegate write | Delegate manage / guardian                 | Admin, browser | Link holder |
| -------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------- | ------------ | --------------- | ------------- | -------------- | ------------------------------------------ | -------------- | ----------- |
| Read own record                                          | yes            | yes                                                                             | no           | read            | sections      | sections       | yes                                        | own only       | selection   |
| Add entries                                              | yes            | yes                                                                             | its scope    | confirmed tools | no            | sections       | yes                                        | own only       | no          |
| Change or delete entries                                 | yes            | yes                                                                             | no           | no              | no            | no             | yes                                        | own only       | no          |
| Export, encrypted archive, share links, feeds            | yes            | yes                                                                             | no           | no              | no            | no             | doctor report only                         | own only       | no          |
| Credentials, sessions, tokens, integrations, channels    | yes            | yes, with step-up where [required](authentication.md#step-up)                   | no           | no              | no            | no             | guardian: integrations, settings, channels | own only       | no          |
| Second-factor management                                 | yes            | with elevation                                                                  | no           | no              | no            | no             | no                                         | own only       | no          |
| AI analysis and Coach                                    | yes            | yes                                                                             | no           | no              | no            | no             | insights to read at manage                 | own only       | no          |
| Sharing, managed profiles                                | yes            | read and write invitations; manage offers and managed profiles are browser-only | no           | no              | no            | no             | no                                         | own only       | no          |
| Account administration, instance settings, backups, keys | no             | no                                                                              | no           | no              | no            | no             | no                                         | yes            | no          |

# Wave 6 — v1.4.23 reconcile report

Closes the multi-agent QA + Product-Lead review pass for v1.4.23.
11 atomic commits across 5 sessions (A, B, D, E, F) collapse the
six-review brief into shippable develop-branch state.

## Per-session SHA chain

| Session | Scope                                                                                                                             | Commit SHAs                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| A       | CRITICAL + HIGH 1-3                                                                                                               | `5486507`, `13977bc`, `d5202e5`, `a2dfc5e` |
| B       | HIGH 4 + simplify (S-02 → S-04) + HIGH 6                                                                                          | `3ee6dab`, `dfffe6b`, `d25e50e`            |
| D       | HIGH 5 (analytics chunked aggregate landed in W5; D session re-confirmed against the W6 senior-dev brief)                         | `deadc73`                                  |
| E       | HIGH 7 (Coach feedback referencing `coach_messages`, plaintext column drop)                                                       | `650f150`                                  |
| F       | MED cluster (Sec-MED-2 Coolify scrub, Sr-MED-5 isCurrent device-id, SLEEP_DURATION migration verification note) + planning record | `1a46bfe` (MED) + this commit (planning)   |

## Counts

- **CRITICAL** — 1 of 1 applied (Session A).
- **HIGH** — 9 of 9 applied (Sessions A/B/D/E).
- **Simplify** — 4 of 5 applied (S-01 through S-04 in Session B);
  S-05 deferred to v1423-backlog.md (touched too many call sites for
  a single reconcile commit).
- **MEDIUM** — 3 applied (Session F); remainder deferred.
- **LOW** — 0 applied; all triaged into v1423-backlog.md.
- **Product-Lead recommendations** — adopted into v1.5 P1 prep notes
  (filed in the next milestone's planning queue, not v1.4.23 backlog).

## Test count delta

| Snapshot                                                      | Unit count |
| ------------------------------------------------------------- | ---------- |
| W5 close (commit `72829b1`)                                   | 2223       |
| Session A close (CRIT + HIGH 1-3 added device + revoke tests) | 2227       |
| Session B close (HIGH 4 + simplify + HIGH 6)                  | ~2229      |
| Session D close (HIGH 5 reconfirm)                            | ~2229      |
| Session E close (HIGH 7 + coach-feedback updates)             | 2235       |
| Session F close (forged X-Device-Id regression)               | **2236**   |

Net delta over the W6 reconcile arc: **+13 unit tests**.

## Items routed to v1423-backlog.md

See `.planning/v1423-backlog.md` for line-by-line context. Headline:

- Settings-cog vs per-message-controls debate (Design pushback).
- Pearson rigorous incomplete-beta replacement (Senior-dev review).
- Sec-MED-1 — `apns_token` partial UNIQUE index (defence-in-depth).
- All four security LOWs (intra-batch duplicate accounting; idempotency
  422 cache hint; APNs key-file path leak; refresh-token failure audit
  missing userId).
- All review LOWs from the other five briefs (code, design, senior-dev,
  simplify, product-lead).
- S-05 simplify deferral (Session B).
- Pre-existing `coach-prefs.test.ts` integration NextRequest URL mock
  issue (Session A flag — predates v1.4.23).
- Sandbox `git commit` silent no-op (Session H7 flag — candidate for a
  `.claude/settings.json` permission tweak).

## Cross-link to v1.4.24

The v1.5 marathon prep work surfaced during Wave 6 product-lead review
(iOS first-launch P1 plan, Coach feedback ingestion analytics, settings
debate resolution) lives in the v1.5 backlog. The v1423-backlog.md is
the v1.4.24 starting queue.

## Wave 6 status

Wave 6 closed at `1a46bfe` + this planning commit. Wave 7 (release) is
next: pre-release verify → version bump → release-merge develop → main
→ tag → GHCR build → Coolify deploy → production smoke.

# SB-9 — Streak endpoint deprecation decision

**Owner:** W-IOS-COORD (v1.4.41)
**Decision:** **already retired — nothing to deprecate.**

## Investigation

iOS v1.4.40 PB1 noted it stops calling `/api/streak/*`. The backlog
flagged that the server might want to either keep responding 200 for
the web app or fully retire the routes.

`ls src/app/api/streak` returns `No such file or directory`. There
are no `route.ts` files under that path. No web frontend code paths
fetch `/api/streak/...`. The only `streak` references in the API are
internal computation inside `src/app/api/insights/targets/route.ts`
(`streakDays`, `streakHighlight`) which is a derived field on an
unrelated payload, not a standalone route.

## Conclusion

There is no `/api/streak/*` surface to deprecate. The iOS team's PB1
note refers to a route family that either never existed on this server
or was removed before the audit. No code action required.

## Action

- No code change.
- Documented here so a future audit doesn't re-open the question.
- iOS team can safely treat `/api/streak/*` as 404 — the web app does
  not depend on the route either.

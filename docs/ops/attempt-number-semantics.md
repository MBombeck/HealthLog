# `attemptNumber` audit-row vs alert-signal semantics

Two numbers describe a failing integration sync, and they can diverge.
On-call operators reading an audit-log row alongside an admin alert
should expect the alert number to be smaller than (or equal to) the
audit number, never the other way around.

## The two numbers

`integrations.sync.failed` audit rows write
`attemptNumber = transient + reauth_required + persistent` — the **sum**
of all three failure buckets. This is the historical "consecutive
failures" running total carried by the legacy
`IntegrationStatus.consecutiveFailures` column (dropped in migration
`0077`, v1.4.47). Auditors looking at a single row see one integer
that captures how many failures the bucket ledger has accumulated since
the last success.

The persistent-failure alert dispatcher in
`src/lib/integrations/status.ts:453` uses `Math.max(...buckets)` — the
**max** across the three buckets. A 3-deep persistent streak pages even
when the transient bucket is empty, and a flapping integration that
ping-pongs between transient and reauth_required never trips a
single-bucket threshold even if its sum looks alarming.

## When the two diverge

A typed-failure-streak edge case: integration fails 2× transient, then
2× reauth_required, then 1× persistent. Audit row shows
`attemptNumber: 5`. Alert signal is `max(2, 2, 1) = 2`, which is below
the default threshold of 3, so no page fires. From the audit log this
looks like a sustained 5-failure outage; from the alert dispatcher it
looks like three small bumps that never crossed a single-bucket
ceiling.

Both readings are correct for their purpose. The audit log records what
happened end-to-end; the alert dispatcher only fires when a single
failure mode persists, because mixed-bucket streaks usually indicate a
transient network blip layered on top of an unrelated reauth prompt —
two problems, neither of which is the "this integration is broken" page
we want to wake someone up for.

## Runbook implication

If you see an audit row with `attemptNumber >= threshold` but no alert
was dispatched, check the per-bucket counts on
`IntegrationStatus.failureBuckets` for that user/integration pair. The
sum may be high while every individual bucket sits below the threshold.
This is working as designed; manually investigate only if a single
bucket is at or above the threshold and `alertedAt` is unset (broken
dispatcher) or set within the last 24 hours (rate-limited, see the
`ALERT_REPEAT_WINDOW_MS` constant).

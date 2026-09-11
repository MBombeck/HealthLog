-- v1.38.19 (Wave E, fix round 1) — the arrival reaction remembers who paid for
-- its reservation.
--
-- The row persisted the reserved amount and the date key but not the cost
-- owner, and two readers need it. The supersede refund in `data-arrival.ts`
-- reverses a pre-provider reservation with no chain in hand at all, so without
-- this column it could only reverse `total_tokens` — leaving the operator
-- share of every superseded reservation on the row forever, walking the
-- operator's ceiling upward against spend that never happened. The resume path
-- in `reaction-line.ts` re-derived the owner from the chain as it stands NOW,
-- and the chain is re-resolved per run and reordered by the health ledger, so
-- a reservation booked to the operator could be reconciled as the user's (the
-- same leak) or vice versa (draining another request's balance).
--
-- Nullable, no default: an existing row's owner is genuinely unknown, and the
-- two readers fall back to the previous behaviour for those.
ALTER TABLE "arrival_reactions"
  ADD COLUMN IF NOT EXISTS "generation_cost_owner" TEXT;

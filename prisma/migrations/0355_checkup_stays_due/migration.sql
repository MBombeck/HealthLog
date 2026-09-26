-- An open check-up stays due after its reminder.
--
-- Until now the reminder tick rolled every delivered reminder on to its next
-- slot. For a reminder on a cycle longer than a week (a fortnightly
-- questionnaire, a yearly check-up) that filed an open task under a slot
-- weeks or a year away the moment it was reminded, without it having been
-- done: the start page and the check-up card then showed it as scheduled far
-- ahead, and a one-shot check-up disappeared altogether.
--
-- From this release such a reminder keeps its due date until it is satisfied
-- (a matching reading or lab result, or marked done), skipped or snoozed, and
-- is reminded again at most once a week while it stays open. A reminder on a
-- weekly or shorter cycle still rolls on. Three steps.

-- 1. The cursor that keeps the repeat to once a week: when a reminder for
--    this row last reached a channel. Nullable, no default; a row that was
--    never reminded simply has none.
ALTER TABLE "measurement_reminders" ADD COLUMN "last_notified_at" TIMESTAMP(3);

-- 2. Put back the due date of reminders the old behaviour rolled on.
--
--    The evidence is the reminder claim ledger: every reminder send first
--    claims `measurement:<reminder id>:<local date>` in `notification_events`
--    (event type MEASUREMENT_REMINDER). The claim is written whether or not a
--    channel delivered, but the roll-on only happened after a delivery, so a
--    row counts as rolled on by a send only when ALL of these hold:
--
--      - it is live and enabled, origin VORSORGE or COACH (never an
--        appointment), and on a cycle the new behaviour holds: an interval
--        longer than seven days, a recurrence rule, or no cadence at all.
--        Measurement reminders are included; whether it names a measurement
--        type does not matter;
--      - it was not done or skipped after that send, and it carries no
--        snooze;
--      - the send was its most recent claim, and the row's last write
--        (`updated_at`) lands within a minute before to ten minutes after
--        that claim. The roll-on is the write that follows a delivery by
--        seconds; any later write (an edit, a snooze, a skip, a Telegram
--        "later") moves `updated_at` past the window and the row is left
--        alone;
--      - the due date it carries now is what the roll-on would have written
--        and what the new behaviour no longer writes: more than a week past
--        the send (a weekly or shorter cycle, including a rule that recurs
--        within the week, still rolls on, so it is not repaired), or no due
--        date at all for a reminder with no cadence.
--
--    The due date goes back to the instant of that send, which is the day
--    the reminder went out and at its notify hour. `last_notified_at`
--    takes the same instant, so the repeat waits a week from that send
--    instead of firing again at the next notify hour. A claim older than the
--    ledger's 90-day retention is gone, and a row rolled on by such a send
--    stays as it is: without the claim there is no evidence of which slot
--    was reminded. A reading or lab result that satisfied the reminder
--    after the send moved `last_satisfied_at` past it, so such a row is
--    excluded above. Nothing is deleted.
WITH latest_claim AS (
  SELECT DISTINCT ON (r."id")
    r."id" AS "reminder_id",
    ne."created_at" AS "sent_at"
  FROM "measurement_reminders" r
  JOIN "notification_events" ne
    ON ne."record_user_id" = r."user_id"
   AND ne."event_type" = 'MEASUREMENT_REMINDER'
   AND ne."dedup_key" LIKE 'measurement:' || r."id" || ':%'
  ORDER BY r."id", ne."created_at" DESC
)
UPDATE "measurement_reminders" r
SET "next_due_at" = lc."sent_at",
    "last_notified_at" = lc."sent_at"
FROM latest_claim lc
WHERE r."id" = lc."reminder_id"
  AND r."deleted_at" IS NULL
  AND r."enabled" = TRUE
  AND r."origin" IN ('VORSORGE', 'COACH')
  AND (
    r."interval_days" > 7
    OR r."rrule" IS NOT NULL
    OR (r."interval_days" IS NULL AND r."rrule" IS NULL)
  )
  AND r."snoozed_until" IS NULL
  AND r."last_notified_at" IS NULL
  AND (r."last_satisfied_at" IS NULL OR r."last_satisfied_at" < lc."sent_at")
  AND (r."last_skipped_at" IS NULL OR r."last_skipped_at" < lc."sent_at")
  AND (r."ends_on" IS NULL OR r."ends_on" > lc."sent_at")
  AND r."updated_at" >= lc."sent_at" - INTERVAL '1 minute'
  AND r."updated_at" <= lc."sent_at" + INTERVAL '10 minutes'
  AND (
    r."next_due_at" > lc."sent_at" + INTERVAL '7 days 12 hours'
    OR (
      r."next_due_at" IS NULL
      AND r."interval_days" IS NULL
      AND r."rrule" IS NULL
    )
  );

-- 3. Show booked visits on the start page for people who chose its items
--    before visits were one of them.
--
--    The start page's item choice is stored as the list of ENABLED kinds, and
--    only when it is not "all of them". A list saved before `upcoming_visit`
--    existed (v1.34.0 to v1.37.1) therefore reads as "visits switched off",
--    although nobody switched them off. Append the kind to every stored,
--    non-empty list that lacks it. An empty list is the whole rail turned off
--    and stays empty. A person who has deliberately switched visits off since
--    v1.37.2 cannot be told apart from one who never had the choice; they see
--    visits again and can switch them off once more, which now sticks.
UPDATE "users"
SET "dashboard_widgets_json" = jsonb_set(
      "dashboard_widgets_json",
      '{enabledHeroItemKinds}',
      ("dashboard_widgets_json" -> 'enabledHeroItemKinds') || '["upcoming_visit"]'::jsonb
    )
WHERE jsonb_typeof("dashboard_widgets_json" -> 'enabledHeroItemKinds') = 'array'
  AND jsonb_array_length("dashboard_widgets_json" -> 'enabledHeroItemKinds') > 0
  AND NOT ("dashboard_widgets_json" -> 'enabledHeroItemKinds') ? 'upcoming_visit';

-- Move a Coach conversation's updated_at back to its newest message.
--
-- The free-text encryption backfill (v1.39.3) and the memory-summary refresh
-- rewrote conversation rows through a Prisma update, which stamped updated_at
-- with the run time. The Coach panel orders and groups by that column, so
-- conversations nobody had touched in months showed up under "Today".
--
-- A turn stamps updated_at in the same transaction that creates its message,
-- so the newest message's created_at is the conversation's real last
-- activity. Only rows more than a minute later than that move back; a rename
-- or a document attached shortly after the last turn keeps its stamp, and a
-- conversation without messages is left alone. Running it again changes
-- nothing: a repaired row is no longer later than its newest message.
--
-- One set-based statement. The per-conversation maximum is read from
-- "coach_messages_conversation_id_created_at_idx" (conversation_id,
-- created_at), so it does not sort the message table.
UPDATE "coach_conversations" AS c
SET "updated_at" = m."last_at"
FROM (
    SELECT "conversation_id", MAX("created_at") AS "last_at"
    FROM "coach_messages"
    GROUP BY "conversation_id"
) AS m
WHERE m."conversation_id" = c."id"
  AND c."updated_at" > m."last_at" + INTERVAL '1 minute';

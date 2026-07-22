-- WHOOP provider identities are globally owned by one local account.
-- Existing duplicate identities keep the earliest connection; ties are broken
-- by the primary key so every database chooses the same winner.
ALTER TABLE "whoop_connections"
    ALTER COLUMN "whoop_user_id" DROP NOT NULL;

WITH ranked_connections AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "whoop_user_id"
            ORDER BY "created_at" ASC, "id" ASC
        ) AS owner_rank
    FROM "whoop_connections"
    WHERE "whoop_user_id" IS NOT NULL
)
UPDATE "whoop_connections" AS connection
SET
    "whoop_user_id" = NULL,
    "updated_at" = CURRENT_TIMESTAMP
FROM ranked_connections AS ranked
WHERE connection."id" = ranked."id"
  AND ranked.owner_rank > 1;

CREATE UNIQUE INDEX "whoop_connections_whoop_user_id_key"
    ON "whoop_connections"("whoop_user_id");

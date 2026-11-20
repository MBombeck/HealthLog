-- The Local provider gets a model column of its own.
--
-- `users.ai_model` was shared by the OpenAI, Anthropic and Local providers,
-- so saving one provider's card overwrote the model another one ran on, and
-- the Local card could only show its model while Local was the selected
-- provider. `ai_local_model` is Local's alone, next to `ai_base_url`, which
-- has only ever been read for Local (the OpenAI arm pins its host, Anthropic
-- takes none, the gateway has `ai_compat_base_url`) and is now named so in the
-- Prisma model (`aiLocalBaseUrl`).
--
-- The copy carries over the model the Local entry ran on until now, which was
-- `ai_model`: for an account whose selected provider is Local, and for one
-- that keeps a Local base URL behind another selected provider that does not
-- own `ai_model` (a gateway, Codex, nothing), whose Local chain entry read the
-- same column. An account on OpenAI or Anthropic keeps its model there and
-- gets no Local model; its Local entry runs on the client default, as it
-- would have with an empty model before.
--
-- `ai_model` is left as it is, so the previous image still finds the model
-- after a rollback.
--
-- One DO block, guarded: a replay after a lock timeout changes nothing,
-- because only an empty `ai_local_model` is filled. Reversibility: drop the
-- column; nothing else changed.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ai_local_model" TEXT;

    UPDATE "users"
       SET "ai_local_model" = "ai_model"
     WHERE "ai_local_model" IS NULL
       AND NULLIF(btrim("ai_model"), '') IS NOT NULL
       AND (
           upper(coalesce("ai_provider", '')) = 'LOCAL'
           OR (
               "ai_base_url" IS NOT NULL
               AND upper(coalesce("ai_provider", '')) NOT IN ('OPENAI', 'ANTHROPIC')
           )
       );
END
$migration$;

/**
 * v1.38.19 (wave D) — "does the shared provider of THIS instance work?",
 * answered for a user who has never made a single AI call.
 *
 * The question comes from the end of the setup flow. The done screen used
 * to claim "insights work for you right away" on the strength of
 * `managedBy === "server"`, which is a PRESENCE read: it says the operator
 * configured a key, never that the key works. On 2026-09-11 the operator's
 * own instance answered HTTP 500 from its OAuth proxy while the screen kept
 * making that promise. This module is the evidence the promise needs.
 *
 * Why it cannot come from the user's own ledger: `provider_health` is unique
 * on `(user_id, provider_type)`, and an account walking the wizard has NO
 * row — for any provider. Its own ledger can only answer "unknown", forever.
 * So the projection folds rows ACROSS accounts. That is also the reason for
 * the shape of the return value.
 *
 * What leaves this module is a tri-state and nothing else: no counts, no
 * timestamps, no user ids, not even "how many accounts are tracked". "The
 * provider of this instance last worked" is a statement about the instance;
 * "seven accounts used it at 06:42Z" is a statement about other people. The
 * admin fold (`GET /api/admin/provider-health`) keeps the second kind and
 * stays behind `requireAdmin()`; this one is readable by any signed-in user
 * precisely because it carries none of it.
 *
 * Fail CLOSED, deliberately against the grain of the ledger it reads. The
 * ledger fails open (`provider-health-ledger.ts`) because there it protects
 * a generation already under way — contributing nothing is the safe outcome.
 * Here the output is a promise made to a person, so a read error, a timeout
 * or an empty table is `unknown`, and `unknown` never buys an offer. It does
 * NOT buy the opposite claim either: an empty table is the state of every
 * instance until its first AI call, and telling that operator "the provider
 * is not answering" is the same unmeasured claim the offer itself avoids.
 *
 * No probe. `POST /api/ai/test` exists and would be the direct answer, but it
 * is a real completion billed to whoever the chain resolves to — usually the
 * operator. A probe here would charge the operator for every registration,
 * and a sign-up bot would scale that bill. The design spec's rule holds:
 * nothing in the flow talks to a provider.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

/**
 * The whole contract. Three words, no payload.
 *
 *   healthy   — the instance's shared provider demonstrably served somebody
 *               inside the freshness window, and no credential is benched.
 *   unhealthy — somebody tried it and the last thing that happened was a
 *               failure. A verdict a screen is allowed to state out loud.
 *   unknown   — nobody has tried it lately on this instance, or the read
 *               failed. Never an offer either, but it is also not a verdict:
 *               a caller may withhold the offer and must not claim an outage.
 */
export type ServerProviderHealth = "healthy" | "unhealthy" | "unknown";

/**
 * How recent a success has to be to still count.
 *
 * The ledger's own cooldowns bracket the choice: 6 h for an auth failure,
 * 5 min for a hard one. A window under those would read `unhealthy` on a
 * quiet single-person instance simply because nothing ran that hour; a much
 * larger one would paint a key that died on Monday as green on Thursday.
 * A day is long enough for an instance with one briefing per morning to hold
 * the threshold, short enough that a dead key goes grey within a day.
 */
export const SERVER_PROVIDER_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The provider tags the operator pays for: the instance-wide OpenAI key and
 * the shared central Codex account. These are exactly the two tags
 * `consent-guard.ts` gates on, and that is not a coincidence — the offer
 * this feeds is the consent for these two and for nothing else.
 */
const SHARED_PROVIDER_TYPES = ["admin-openai", "admin-codex"] as const;

export async function readServerProviderHealth(
  now: Date = new Date(),
): Promise<ServerProviderHealth> {
  let rows: Array<{
    lastResult: string;
    lastOkAt: Date | null;
    nextRetryAt: Date | null;
  }>;
  try {
    rows = await prisma.providerHealth.findMany({
      where: { providerType: { in: [...SHARED_PROVIDER_TYPES] } },
      // Three columns, none of which identifies an account. The absence of
      // `userId` here is load-bearing, not tidiness.
      select: { lastResult: true, lastOkAt: true, nextRetryAt: true },
    });
  } catch {
    annotate({ action: { name: "ai.server_health.read_failed" } });
    return "unknown";
  }

  if (rows.length === 0) return "unknown";

  // A benched credential outranks any success. A 401/403 is not one
  // account's bad luck — the operator's key is one object, and while it is
  // in its cooldown it is dead for everybody, including whoever is reading
  // this screen right now.
  const credentialBenched = rows.some(
    (row) =>
      row.lastResult === "auth_failed" &&
      row.nextRetryAt !== null &&
      row.nextRetryAt.getTime() > now.getTime(),
  );
  if (credentialBenched) return "unhealthy";

  const floor = now.getTime() - SERVER_PROVIDER_FRESH_WINDOW_MS;
  const workedRecently = rows.some(
    (row) => row.lastOkAt !== null && row.lastOkAt.getTime() >= floor,
  );
  if (workedRecently) return "healthy";

  // Nothing succeeded inside the window, and that alone is not a failure.
  // `unhealthy` is a statement the screen puts to a person — "it is not
  // answering" — so it has to be earned by an outcome somebody actually
  // observed: a row whose LAST outcome was a failure, uncontradicted by a
  // recent success. When every row's last outcome was a success and it is
  // merely old, nobody has asked this provider for anything lately, and the
  // honest answer is that we do not know. Either way there is no offer.
  const lastOutcomeFailed = rows.some((row) => row.lastResult !== "ok");
  return lastOutcomeFailed ? "unhealthy" : "unknown";
}

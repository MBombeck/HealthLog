/**
 * POST /api/coach/about-me/adopt — fold a clarifying-question answer
 * back into the stored self-context.
 *
 * v1.16.4 — closes the questions loop: the Coach composer's pending
 * chips (`/api/coach/about-me/questions`) insert a question the user
 * answers in their own words; this endpoint lets that answer flow back
 * into the matching structured self-context field instead of living
 * only in the chat transcript. Additive — the existing GET/PUT
 * `/api/coach/about-me` contract is untouched.
 *
 * Semantics:
 *   - The target field is picked from the QUESTION wording (allergy /
 *     condition keywords across the six UI locales; everything else
 *     lands on `coachFocus`, the "what the Coach should know" slot).
 *     v1.16.8 — the question is optional: the remember action on a
 *     chat message sends only the message text, and the field is then
 *     matched from that text ("ich habe eine Erdnussallergie" lands on
 *     `allergies` directly).
 *   - Dedupe: an answer already contained in the target field (or in
 *     the free-text `aboutMe`) is a no-op (`adopted: false`) — tapping
 *     the offer twice or re-answering the same chip cannot stack
 *     duplicate prose.
 *   - Append, never replace: existing text stays; the answer joins on
 *     its own line, encrypted at rest like every self-context write.
 *     A structured field at its cap overflows into `aboutMe`.
 *   - Audit rows carry lengths only — the text is free-form health
 *     prose and must not land in plaintext audit details.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { getSelfContextForUser } from "@/lib/ai/coach/about-me";
import { requireModuleEnabled } from "@/lib/modules/gate";
import {
  ABOUT_ME_FIELD_MAX_CHARS,
  ABOUT_ME_MAX_CHARS,
  aboutMeAdoptSchema,
} from "@/lib/validations/about-me";

const POST_RATE_LIMIT = 30;
const POST_WINDOW_MS = 60_000;

type StructuredField = "conditions" | "allergies" | "coachFocus";

/**
 * Keyword match against the question wording — or, for the
 * message-remember path, against the message text itself — covering
 * the six UI locales the question generator writes in (de / en / es /
 * fr / it / pl). Stems, not words, so inflections match. Anything that
 * is not clearly an allergy or condition statement lands on
 * `coachFocus` — the generic "worth knowing for the Coach" slot.
 */
function matchSelfContextField(question: string): StructuredField {
  const q = question.toLowerCase();
  const allergyStems = [
    "allerg", // de/en/fr/it
    "alergi", // es/pl
    "uczulen", // pl
    "intoleran", // de/en/es/it
    "unverträglich", // de
  ];
  if (allergyStems.some((s) => q.includes(s))) return "allergies";
  const conditionStems = [
    "erkrank", // de
    "krankheit", // de
    "diagnos", // de/en/es/fr/it/pl
    "condition", // en
    "chronic", // en
    "chronisch", // de
    "enfermedad", // es
    "maladie", // fr
    "malatt", // it
    "chorob", // pl
  ];
  if (conditionStems.some((s) => q.includes(s))) return "conditions";
  return "coachFocus";
}

/** Whitespace-collapsed lowercase form for containment dedupe. */
function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export const POST = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();
  // v1.18.0 — Coach module gate (operator availability + disableCoach).
  const gate = await requireModuleEnabled(user.id, "coach");
  if (!gate.enabled) return gate.response;

  const rl = await checkRateLimit(
    `coach-about-me:adopt:${user.id}`,
    POST_RATE_LIMIT,
    POST_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const parsed = await parseJsonBody(req, aboutMeAdoptSchema, {
    maxBytes: 16 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  const { question, answer } = parsed.data;
  const normAnswer = normalise(answer);
  // Question-led adoptions (guided dialog) match the field from the
  // question wording; the message-remember path matches from the
  // message text itself.
  const matchSource = question ?? answer;
  const adoptionSource = question ? "question" : "message";

  // Read-modify-write under a row lock: two concurrent adoptions used
  // to read the same base value and one append silently lost (or the
  // dedupe missed the other's in-flight write). The empty upsert pins
  // the row, `FOR UPDATE` serialises every adoption for this user, and
  // the read happens through the same `tx` so it sees the locked state.
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.userHealthProfile.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: {},
      select: { id: true },
    });
    await tx.$queryRaw`
      SELECT id FROM user_health_profiles
      WHERE user_id = ${user.id}
      FOR UPDATE
    `;
    const ctx = await getSelfContextForUser(user.id, tx);

    let field: StructuredField | "aboutMe" = matchSelfContextField(matchSource);

    // Dedupe BEFORE any write: an answer already present in the target
    // field or in the free-text aboutMe never stacks a second copy.
    const targetExisting = ctx[field];
    if (
      (targetExisting && normalise(targetExisting).includes(normAnswer)) ||
      (ctx.aboutMe && normalise(ctx.aboutMe).includes(normAnswer))
    ) {
      return { kind: "duplicate" as const, field };
    }

    // Append on its own line; a structured field at its cap overflows
    // into the free-text aboutMe (4000 chars) rather than failing the
    // adoption outright.
    let nextValue = targetExisting ? `${targetExisting}\n${answer}` : answer;
    if (nextValue.length > ABOUT_ME_FIELD_MAX_CHARS) {
      field = "aboutMe";
      nextValue = ctx.aboutMe ? `${ctx.aboutMe}\n${answer}` : answer;
      if (nextValue.length > ABOUT_ME_MAX_CHARS) {
        return { kind: "full" as const, field };
      }
    }

    // Field-by-field assembly (no mass assignment): exactly one
    // encrypted column is written per adoption.
    const column = (
      {
        conditions: "conditionsEncrypted",
        allergies: "allergiesEncrypted",
        coachFocus: "coachFocusEncrypted",
        aboutMe: "aboutMeEncrypted",
      } as const
    )[field];

    await tx.userHealthProfile.update({
      where: { userId: user.id },
      data: { [column]: encryptToBytes(nextValue) },
      select: { updatedAt: true },
    });
    return { kind: "adopted" as const, field };
  });

  const { field } = outcome;
  if (outcome.kind === "duplicate") {
    annotate({
      action: { name: "coach.about_me.adopt_deduped" },
      meta: { field, source: adoptionSource },
    });
    return apiSuccess({ adopted: false, field, reason: "duplicate" });
  }
  if (outcome.kind === "full") {
    return apiError("Self-context is full", 422);
  }

  await auditLog("coach.about_me.adopted", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: { field, answerLength: answer.length, source: adoptionSource },
  });

  annotate({
    action: { name: "coach.about_me.adopted" },
    meta: { field, answer_length: answer.length, source: adoptionSource },
  });

  return apiSuccess({ adopted: true, field });
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

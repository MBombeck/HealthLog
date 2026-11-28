/**
 * GET /api/coach/about-me — the caller's structured self-context.
 * PUT /api/coach/about-me — write (or clear) the self-context.
 *
 * v1.15.20 — free-text "about me", encrypted at rest.
 * v1.16.0 — extended with three structured fields (conditions,
 * allergies, coach focus; each ≤500 chars, encrypted) and the
 * clarifying-questions loop: after a save the server derives up to 3
 * follow-up questions (AI when a provider + the daily Coach budget
 * allow, deterministic hints otherwise) and persists them encrypted;
 * the Coach composer renders them as tappable chips
 * (`/api/coach/about-me/questions`).
 *
 * PUT field semantics: every text field is optional. An omitted field stays
 * untouched; an empty string clears it. This also lets the inclusion controls
 * change without resubmitting encrypted text that the current key cannot read.
 *
 * Plain text end to end: the client renders every value as a React
 * text child only — no markdown library exists in the tree and none
 * may be added (XSS posture, see the contributor notes).
 *
 * The follow-up questions are the one AI part. Model-written questions are
 * derived and served only while the `aboutMeQuestions` capability is
 * available; otherwise the deterministic completion hints stand in, no
 * provider is called, and the `ai` field says why. Stored questions cannot be
 * told apart by origin, so while the capability is unavailable an outstanding
 * set is replaced on read by the deterministic hints for the same profile.
 *
 * Ownership: the user id always comes from `requireAuth()`; the body
 * carries only the text. Audit rows never contain the text itself —
 * only per-field lengths — because it is free-form health prose.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserInsights } from "@/lib/cache/invalidate";
import { prisma } from "@/lib/db";
import { lockAiSections } from "@/lib/profile/life-circumstances";
import { takeBaseToken, invalidBaseTokenError } from "@/lib/optimistic-lock";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  getPendingQuestionsForUser,
  getSelfContextForUser,
  filterSelfContextForAi,
  setPendingQuestionsForUser,
} from "@/lib/ai/coach/about-me";
import {
  buildFallbackQuestions,
  deriveClarifyingQuestions,
} from "@/lib/ai/coach/self-context-questions";
import { getAiCapability } from "@/lib/ai/capabilities/gate";
import { requireModuleEnabled } from "@/lib/modules/gate";
import {
  ABOUT_ME_FIELD_MAX_CHARS,
  ABOUT_ME_MAX_CHARS,
  aboutMePutSchema,
} from "@/lib/validations/about-me";
import {
  DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
  HEALTH_PROFILE_AI_SECTIONS,
  aboutMeAiSections,
  type StoredHealthProfileAiSection,
} from "@/lib/validations/health-profile-facts";
import { INSIGHTS_CACHE_CLEARED } from "@/lib/insights/cached-text-cipher";

const PUT_RATE_LIMIT = 30;
const PUT_WINDOW_MS = 60_000;

type SelfContextConsumerGate =
  | { enabled: true; coachEnabled: boolean }
  | { enabled: false; response: Response };

async function requireSelfContextConsumer(
  userId: string,
): Promise<SelfContextConsumerGate> {
  const coachGate = await requireModuleEnabled(userId, "coach");
  if (coachGate.enabled) return { enabled: true, coachEnabled: true };

  const insightsGate = await requireModuleEnabled(userId, "insights");
  if (insightsGate.enabled) return { enabled: true, coachEnabled: false };

  return coachGate;
}
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  const gate = await requireSelfContextConsumer(user.id);
  if (!gate.enabled) return gate.response;

  const [ctx, storedQuestions, row, ai] = await Promise.all([
    getSelfContextForUser(user.id),
    gate.coachEnabled
      ? getPendingQuestionsForUser(user.id)
      : Promise.resolve<string[]>([]),
    prisma.userHealthProfile.findUnique({
      where: { userId: user.id },
      select: { aboutMeRevisedAt: true, aiIncludedSections: true },
    }),
    getAiCapability("aboutMeQuestions"),
  ]);
  // The eight sections this wire has always carried. The life-circumstance
  // sections (v1.43) live in the same column but are switched and read
  // through `/api/anamnesis/life-circumstances`; older app builds decode this
  // list closed.
  const aiIncludedSections = aboutMeAiSections(
    row?.aiIncludedSections ?? DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
  );
  // A stored set may be model-written. While the capability is unavailable
  // an outstanding set is swapped for the deterministic hints; an answered
  // (empty) set stays empty.
  const pendingQuestions =
    ai.available || storedQuestions.length === 0
      ? storedQuestions
      : buildFallbackQuestions(
          filterSelfContextForAi(ctx, aiIncludedSections),
          await resolveServerLocale({ userLocale: user.locale ?? null }),
          aiIncludedSections,
        );

  annotate({
    action: { name: "coach.about_me.get" },
    meta: {
      present: ctx.aboutMe !== null,
      structured:
        ctx.conditions !== null ||
        ctx.allergies !== null ||
        ctx.coachFocus !== null,
    },
  });

  return apiSuccess({
    aboutMe: ctx.aboutMe,
    conditions: ctx.conditions,
    allergies: ctx.allergies,
    coachFocus: ctx.coachFocus,
    pendingQuestions,
    aiIncludedSections,
    updatedAt: row?.aboutMeRevisedAt?.toISOString() ?? null,
    maxChars: ABOUT_ME_MAX_CHARS,
    fieldMaxChars: ABOUT_ME_FIELD_MAX_CHARS,
    ai,
  });
});

export const PUT = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();
  const gate = await requireSelfContextConsumer(user.id);
  if (!gate.enabled) return gate.response;

  const rl = await checkRateLimit(
    `coach-about-me:put:${user.id}`,
    PUT_RATE_LIMIT,
    PUT_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const { data: rawBody, error: jsonError } = await safeJson(req, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  // v1.32.21 — pull the optimistic-concurrency base token off the body
  // BEFORE the Zod parse (issue #581 family). The token guards on
  // `UserHealthProfile.aboutMeRevisedAt`, the document's own revision: the
  // emergency profile and the pending questions share this row, and a write
  // to them must not make an about-me save conflict.
  const taken = takeBaseToken(rawBody);
  if ("invalid" in taken) return invalidBaseTokenError();
  const base = taken.base;

  const parsed = aboutMePutSchema.safeParse(taken.rest);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422);
  }

  const text = parsed.data.aboutMe?.trim();
  const textFieldsChanged =
    parsed.data.aboutMe !== undefined ||
    parsed.data.conditions !== undefined ||
    parsed.data.allergies !== undefined ||
    parsed.data.coachFocus !== undefined;
  const questionsNeedRefresh =
    textFieldsChanged || parsed.data.aiIncludedSections !== undefined;

  // Field-by-field data assembly (no mass assignment): omitted fields
  // never appear in the update object, so they stay untouched.
  const encryptOptional = (
    raw: string | undefined,
  ): Uint8Array<ArrayBuffer> | null | undefined => {
    if (raw === undefined) return undefined;
    const value = raw.trim();
    return value.length === 0 ? null : encryptToBytes(value);
  };
  const update: {
    aboutMeEncrypted?: Uint8Array<ArrayBuffer> | null;
    conditionsEncrypted?: Uint8Array<ArrayBuffer> | null;
    allergiesEncrypted?: Uint8Array<ArrayBuffer> | null;
    coachFocusEncrypted?: Uint8Array<ArrayBuffer> | null;
    aiIncludedSections?: StoredHealthProfileAiSection[];
  } = {};
  const aboutMePayload = encryptOptional(parsed.data.aboutMe);
  if (aboutMePayload !== undefined) {
    update.aboutMeEncrypted = aboutMePayload;
  }
  const conditionsPayload = encryptOptional(parsed.data.conditions);
  if (conditionsPayload !== undefined) {
    update.conditionsEncrypted = conditionsPayload;
  }
  const allergiesPayload = encryptOptional(parsed.data.allergies);
  if (allergiesPayload !== undefined) {
    update.allergiesEncrypted = allergiesPayload;
  }
  const coachFocusPayload = encryptOptional(parsed.data.coachFocus);
  if (coachFocusPayload !== undefined) {
    update.coachFocusEncrypted = coachFocusPayload;
  }
  const fieldLengths: Record<string, number> = {
    ...(text !== undefined ? { aboutMe: text.length } : {}),
    ...(parsed.data.conditions !== undefined
      ? { conditions: parsed.data.conditions.trim().length }
      : {}),
    ...(parsed.data.allergies !== undefined
      ? { allergies: parsed.data.allergies.trim().length }
      : {}),
    ...(parsed.data.coachFocus !== undefined
      ? { coachFocus: parsed.data.coachFocus.trim().length }
      : {}),
  };

  // Keep the profile write and the persistent Insights cache clear in the
  // same transaction. If either write fails, an inclusion change cannot
  // commit while an hour-fresh advisor payload still references excluded
  // profile content.
  const persistence = await prisma.$transaction(async (tx) => {
    // A PUT here replaces the eight sections it lists and leaves the
    // life-circumstance switches (v1.43) exactly as stored.
    if (parsed.data.aiIncludedSections !== undefined) {
      // Taken before the read, so a switch changed concurrently is read
      // after it commits and carried over as it now stands.
      await lockAiSections(tx, user.id);
      const stored = await tx.userHealthProfile.findUnique({
        where: { userId: user.id },
        select: { aiIncludedSections: true },
      });
      update.aiIncludedSections = [
        ...parsed.data.aiIncludedSections,
        ...(stored?.aiIncludedSections ?? []).filter(
          (section) =>
            !(HEALTH_PROFILE_AI_SECTIONS as readonly string[]).includes(
              section,
            ),
        ),
      ];
    }
    let updatedAtIso: string;
    let savedProfileUpdatedAt: Date | null = null;

    // Optimistic concurrency on the about-me document's own revision
    // (`aboutMeRevisedAt`, moved by the database when one of its fields does).
    //   - no base token → today's upsert (backward-compat arm);
    //   - base present + row still carries it → conditional update;
    //   - base present + zero match → create if the row vanished, otherwise
    //     report a real conflict without clearing the cache.
    if (base === undefined) {
      const row = await tx.userHealthProfile.upsert({
        where: { userId: user.id },
        create: { userId: user.id, ...update },
        update,
        select: { aboutMeRevisedAt: true },
      });
      updatedAtIso = row.aboutMeRevisedAt.toISOString();
      savedProfileUpdatedAt = row.aboutMeRevisedAt;
    } else {
      const guarded = await tx.userHealthProfile.updateMany({
        where: { userId: user.id, aboutMeRevisedAt: base },
        data: update,
      });
      if (guarded.count === 0) {
        const existing = await tx.userHealthProfile.findUnique({
          where: { userId: user.id },
          select: { aboutMeRevisedAt: true },
        });
        if (existing) {
          return {
            conflict: true as const,
            baseUpdatedAt: base.toISOString(),
          };
        }
        const created = await tx.userHealthProfile.create({
          data: { userId: user.id, ...update },
          select: { aboutMeRevisedAt: true },
        });
        updatedAtIso = created.aboutMeRevisedAt.toISOString();
        savedProfileUpdatedAt = created.aboutMeRevisedAt;
      } else {
        const fresh = await tx.userHealthProfile.findUnique({
          where: { userId: user.id },
          select: { aboutMeRevisedAt: true },
        });
        updatedAtIso = (fresh?.aboutMeRevisedAt ?? new Date()).toISOString();
        savedProfileUpdatedAt = fresh?.aboutMeRevisedAt ?? null;
      }
    }

    if (parsed.data.aiIncludedSections !== undefined) {
      await tx.user.update({
        where: { id: user.id },
        data: {
          insightsCachedAt: null,
          ...INSIGHTS_CACHE_CLEARED,
          insightsCachedLocale: null,
        },
      });
    }

    return {
      conflict: false as const,
      updatedAtIso,
      savedProfileUpdatedAt,
    };
  });

  if (persistence.conflict) {
    annotate({
      action: { name: "coach.about_me.conflict" },
      meta: { base_updated_at: persistence.baseUpdatedAt },
    });
    return apiError("Self-context changed since it was loaded", 409, {
      errorCode: "about_me_conflict",
    });
  }

  let { updatedAtIso } = persistence;
  const { savedProfileUpdatedAt } = persistence;
  if (parsed.data.aiIncludedSections !== undefined) {
    invalidateUserInsights(user.id);
  }

  // Read back the effective state (covers omitted fields) and derive
  // the clarifying questions. An entirely empty self-context clears
  // the pending questions instead of generating new ones.
  const [ctx, controlRow] = await Promise.all([
    getSelfContextForUser(user.id),
    prisma.userHealthProfile.findUnique({
      where: { userId: user.id },
      select: { aiIncludedSections: true },
    }),
  ]);
  const aiIncludedSections = aboutMeAiSections(
    controlRow?.aiIncludedSections ?? DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
  );
  const aiContext = filterSelfContextForAi(ctx, aiIncludedSections);
  const aiContextIsEmpty =
    aiContext.aboutMe === null &&
    aiContext.conditions === null &&
    aiContext.allergies === null &&
    aiContext.coachFocus === null;
  const storedContextIsEmpty =
    ctx.aboutMe === null &&
    ctx.conditions === null &&
    ctx.allergies === null &&
    ctx.coachFocus === null;

  const ai = await getAiCapability("aboutMeQuestions");
  let pendingQuestions: string[] = [];
  let questionsToPersist: string[] | null | undefined;
  let questionsSource: "ai" | "fallback" | "none" = "none";
  if (!gate.coachEnabled) {
    if (parsed.data.aiIncludedSections !== undefined) {
      questionsToPersist = null;
    }
  } else if (!questionsNeedRefresh) {
    pendingQuestions = await getPendingQuestionsForUser(user.id);
  } else if (aiContextIsEmpty) {
    questionsToPersist = null;
  } else {
    const derived = await deriveClarifyingQuestions(
      user.id,
      aiContext,
      await resolveServerLocale({ userLocale: user.locale ?? null }),
      aiIncludedSections,
      { aiAvailable: ai.available },
    );
    pendingQuestions = derived.questions;
    questionsSource = derived.source;
    questionsToPersist = pendingQuestions;
  }

  if (questionsToPersist !== undefined) {
    const persisted =
      savedProfileUpdatedAt !== null &&
      (await setPendingQuestionsForUser(
        user.id,
        questionsToPersist,
        savedProfileUpdatedAt,
      ));
    if (!persisted) {
      pendingQuestions = await getPendingQuestionsForUser(user.id);
      questionsSource = "none";
    }
  }
  const cleared = textFieldsChanged && storedContextIsEmpty;

  // The audit row carries per-field lengths only — the text is
  // free-form health prose and must not land in the plaintext audit
  // details.
  await auditLog(
    cleared ? "coach.about_me.cleared" : "coach.about_me.updated",
    {
      userId: user.id,
      ipAddress: getClientIp(req),
      details: { ...fieldLengths },
    },
  );

  annotate({
    action: {
      name: cleared ? "coach.about_me.cleared" : "coach.about_me.updated",
    },
    meta: {
      length: text?.length,
      questions_source: questionsSource,
      questions_count: pendingQuestions.length,
    },
  });

  const finalProfileRow = await prisma.userHealthProfile.findUnique({
    where: { userId: user.id },
    select: { aboutMeRevisedAt: true },
  });
  if (finalProfileRow) {
    updatedAtIso = finalProfileRow.aboutMeRevisedAt.toISOString();
  }

  return apiSuccess({
    aboutMe: ctx.aboutMe,
    conditions: ctx.conditions,
    allergies: ctx.allergies,
    coachFocus: ctx.coachFocus,
    pendingQuestions,
    aiIncludedSections,
    updatedAt: updatedAtIso,
    maxChars: ABOUT_ME_MAX_CHARS,
    fieldMaxChars: ABOUT_ME_FIELD_MAX_CHARS,
    ai,
  });
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

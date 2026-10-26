import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import { capFields, capped, cappedOutput } from "@/lib/mcp/capped";
import { fenceUserText, scrubFenceMarkers } from "@/lib/ai/coach/data-fence";
import { listTargetsBySource } from "@/lib/links";
import { encounterKindEnum } from "@/lib/validations/encounters";
import { decryptVisitText } from "./shared";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

/**
 * Output schema for `get_visits` — the account's own past visits, bounded.
 *
 * Follows `get_preventive_care`'s shape: every field beyond `present` is
 * optional so a grounded `{ present: false }` miss and a full hit both validate
 * against one schema (the ChatGPT Apps-SDK conformance rule the other reads
 * follow). Absence is `{ present: false }`, never `{ present: true, visits: [] }`
 * — "you have never recorded a visit" and "you have no visits" are different
 * claims and only the first is true when the list is empty.
 */
const getVisitsOutput: z.ZodRawShape = {
  present: z.boolean(),
  // Null when the read covered the whole record: a procedure history asked
  // for without a window (v1.39.1).
  windowMonths: z.number().nullable().optional(),
  visits: z
    .array(
      z.object({
        occurredAt: z.string(),
        status: z.string(),
        kind: z.string(),
        practitioner: z.string().nullable(),
        specialty: z.string().nullable(),
        reason: z.string().nullable(),
        outcome: z.string().nullable(),
        bodySite: z.string().nullable(),
        laterality: z.enum(["LEFT", "RIGHT", "BOTH"]).nullable(),
        conditions: z.array(z.string()),
      }),
    )
    .optional(),
  // "module_disabled" when the illness module is off and the condition
  // labels are withheld rather than absent (v1.39.3).
  conditionsReason: z.string().optional(),
  ...cappedOutput,
};

/** Default trailing window for `get_visits` when the caller names none. */
const DEFAULT_VISITS_WINDOW_MONTHS = 12;
/** Hard cap on the `get_visits` window, so an unbounded read is impossible. */
const MAX_VISITS_WINDOW_MONTHS = 60;
/** Newest-first cap on the visits one `get_visits` call returns. */
const MAX_VISITS = 50;

export const getVisitsTool: McpToolDefinition = {
  name: "get_visits",
  title: "Get past doctor visits",
  description:
    "Fetch the user's own past doctor visits over a bounded window (default: the last 12 months) so a question like 'when did I last see a cardiologist' is answerable from the record. Each visit carries its date, lifecycle status (DONE / CANCELLED / NO_SHOW — a no-show is not a visit that happened), kind, practitioner name + specialty, the visit's own free-text reason and outcome, the body site and side (set on procedures), and the labels of any conditions it was filed against. Optionally narrow to one practitioner by a name substring, or to one kind. kind PROCEDURE is the procedure and surgery history: without a months argument it reads the whole record, because a surgery years ago is still the answer to 'what surgeries have I had'. Newest first, bounded. Returns { present: false } when the user has never recorded a visit — distinct from a filtered read that simply matched none. With the illness module switched off the condition labels are withheld and conditionsReason is \"module_disabled\".",
  inputShape: {
    months: z
      .number()
      .int()
      .min(1)
      .max(MAX_VISITS_WINDOW_MONTHS)
      .optional()
      .describe(
        "Trailing window in months. Defaults to 12, capped at 60. Past visits only — a future appointment is surfaced by get_preventive_care, not here.",
      ),
    practitioner: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Optional case-insensitive name substring to narrow to one practitioner (e.g. a surname read back from an earlier result). Omit for every practitioner.",
      ),
    kind: encounterKindEnum
      .optional()
      .describe(
        "Optional visit kind to narrow to. PROCEDURE lists procedures and surgeries, over the whole record unless months is given.",
      ),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: getVisitsOutput,
  async run(ctx, args) {
    const kindArg = encounterKindEnum.safeParse(args.kind);
    const kind = kindArg.success ? kindArg.data : undefined;
    // A procedure history is lifetime reference data; every other read keeps
    // the default year. A window the caller names always wins.
    const months =
      typeof args.months === "number"
        ? args.months
        : kind === "PROCEDURE"
          ? null
          : DEFAULT_VISITS_WINDOW_MONTHS;
    const practitioner =
      typeof args.practitioner === "string" && args.practitioner.trim()
        ? args.practitioner.trim()
        : undefined;
    const now = new Date();
    const cutoff = months === null ? null : new Date(now);
    cutoff?.setMonth(cutoff.getMonth() - (months ?? 0));

    const { rows, cap } = await capped(MAX_VISITS, (take) =>
      prisma.encounter.findMany({
        // `userId` is the resolved session's, never an argument — a visit
        // belonging to another account is unreachable by construction.
        where: {
          userId: ctx.userId,
          deletedAt: null,
          occurredAt: { ...(cutoff ? { gte: cutoff } : {}), lte: now },
          ...(kind ? { kind } : {}),
          ...(practitioner
            ? {
                practitioner: {
                  is: {
                    name: { contains: practitioner, mode: "insensitive" },
                    deletedAt: null,
                  },
                },
              }
            : {}),
        },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take,
        include: {
          practitioner: {
            select: { name: true, specialty: true },
          },
        },
      }),
    );

    // Absence is explicit. An empty list is { present: false } — "you have
    // never recorded a visit" — NEVER { present: true, visits: [] }, which
    // would read as "you have no visits", a claim the empty read cannot make.
    if (rows.length === 0) {
      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "get_visits", present: false },
      });
      return { present: false };
    }

    // The linked condition labels, one grouped read for the whole page, from
    // the same link service every other visit surface goes through.
    // With the illness module off the condition table is not read, and
    // the answer says why the labels are missing (v1.39.3).
    const illnessOn = await isModuleEnabled(ctx.userId, "illness");
    const conditionsBySource = illnessOn
      ? await listTargetsBySource(prisma, {
          userId: ctx.userId,
          sourceKind: "encounter",
          sourceIds: rows.map((r) => r.id),
          targetKind: "conditionEpisode",
        })
      : new Map<string, Array<{ label: string }>>();

    const visits = rows.map((r) => {
      const reason = decryptVisitText(r.reasonEncrypted);
      const outcome = decryptVisitText(r.outcomeEncrypted);
      const bodySite = decryptVisitText(r.bodySiteEncrypted);
      // A live visit names its practitioner even after the address-book
      // entry is deleted, as the web record does.
      const seenBy = r.practitioner;
      return {
        occurredAt: r.occurredAt.toISOString(),
        status: r.status,
        kind: r.kind,
        practitioner: seenBy ? scrubFenceMarkers(seenBy.name) : null,
        specialty: seenBy?.specialty
          ? scrubFenceMarkers(seenBy.specialty)
          : null,
        // Reason and outcome are user- and document-derived free text, so
        // they ride the USER_TEXT wrapping; the markers are stripped from the
        // content they wrap. A condition label is the user's own free text
        // too — scrubbed of any forged marker before it enters the payload.
        reason: reason !== null ? fenceUserText(reason) : null,
        outcome: outcome !== null ? fenceUserText(outcome) : null,
        bodySite: bodySite !== null ? fenceUserText(bodySite) : null,
        laterality: r.laterality,
        conditions: (conditionsBySource.get(r.id) ?? []).map((c) =>
          scrubFenceMarkers(c.label),
        ),
      };
    });

    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_visits", present: true },
    });
    return {
      present: true,
      windowMonths: months,
      visits,
      ...capFields(cap),
      ...(illnessOn ? {} : { conditionsReason: "module_disabled" }),
    };
  },
};

import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { readLatestEver } from "@/lib/dashboard/summary-reads";
import { annotate } from "@/lib/logging/context";
import { buildCoachDataInventory } from "@/lib/ai/coach/tools/inventory";
import { isModuleEnabled } from "@/lib/modules/gate";
import { resolveBaseOrigin } from "@/lib/mcp/oauth/config";
import {
  MCP_CLINICAL_SIGNALS,
  MCP_METRIC_STATUS_DISCOVERY,
} from "@/lib/mcp/rich-reads";
import { NUTRIENT_LABELS } from "@/lib/mcp/nutrients-read";
import { NUTRIENT_CODES } from "@/lib/nutrients/catalog";
import { encodeOffsetCursor, decodeOffsetCursor } from "@/lib/mcp/pagination";
import { capped, cappedOutput } from "@/lib/mcp/capped";
import { scrubFenceMarkers } from "@/lib/ai/coach/data-fence";
import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";
import { loadRecordCandidates } from "@/lib/mcp/record-search";
import {
  rankCandidates,
  WEIGHT as SEARCH_WEIGHT,
  type SearchCandidate,
} from "@/lib/search/match";
import type { McpAuthContext } from "../auth";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

/** Results per `search` page. */
const SEARCH_PAGE_SIZE = 50;
/**
 * Per-source scan ceiling the `search` assembler reads before paging. Raised
 * from the prior 200 (which made any item past the 200th unreachable, even
 * through the cursor) to a generous documented cap so the opaque offset cursor
 * pages the FULL assembled set. A user with more medications or distinct lab
 * analytes than this ceiling is well outside any realistic personal record.
 */
const SEARCH_RESULT_SCAN_CAP = 2000;

/** Adds one candidate of the older kinds (metric, medication, lab, nutrient). */
type AddCandidate = (
  id: string,
  title: string,
  url: string,
  hay: string,
) => void;

/** What one `search` call assembles before it ranks. */
interface SearchAssembly {
  // Every kind lands here as a candidate with the fields it can be
  // matched on; one ranking (`rankCandidates`) filters and orders them
  // all, so a visit and a medication compete on the same terms.
  candidates: SearchCandidate[];
  legacy: AddCandidate;
  // Sources whose read stopped at its ceiling, so the result can say it
  // was assembled from part of the record instead of reading as all of
  // it.
  truncatedSources: string[];
}

function startAssembly(): SearchAssembly {
  const candidates: SearchCandidate[] = [];
  let seq = 0;
  const legacy = (
    id: string,
    title: string,
    url: string,
    hay: string,
  ): void => {
    candidates.push({
      id,
      title,
      url,
      // The older kinds keep their assembly order on a tie.
      kindOrder: seq++,
      date: null,
      fields: [{ text: hay, weight: SEARCH_WEIGHT.primary }],
    });
  };
  return { candidates, legacy, truncatedSources: [] };
}

/** The metric domains the Coach data inventory holds. */
async function addInventoryCandidates(
  ctx: McpAuthContext,
  origin: string,
  legacy: AddCandidate,
): Promise<void> {
  const inventory = await buildCoachDataInventory(ctx.userId, undefined);
  for (const entry of inventory.entries) {
    if (!entry.present) continue;
    // Per-item deep-link where a metric id exists (mirrors `fetch`),
    // else the generic insights landing for a whole-domain row.
    legacy(
      entry.metric ? `metric:${entry.metric}` : `domain:${entry.domain}`,
      entry.domain,
      entry.metric
        ? `${origin}/insights?metric=${encodeURIComponent(entry.metric)}`
        : `${origin}/insights`,
      `${entry.domain} ${entry.metric ?? ""}`,
    );
  }
}

/** The medications and lab analytes, each behind its module switch. */
async function addMedicationAndLabCandidates(
  ctx: McpAuthContext,
  origin: string,
  { legacy, truncatedSources }: SearchAssembly,
): Promise<void> {
  // A switched-off module's records never appear. The
  // medication and lab reads below predate the rule and were ungated.
  const [medicationsOn, labsOn] = await Promise.all([
    isModuleEnabled(ctx.userId, "medications"),
    isModuleEnabled(ctx.userId, "labs"),
  ]);

  const meds = medicationsOn
    ? await capped(SEARCH_RESULT_SCAN_CAP, (take) =>
        prisma.medication.findMany({
          where: { userId: ctx.userId },
          select: { id: true, name: true, dose: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take,
        }),
      ).then(({ rows, cap }) => {
        if (cap.truncated) truncatedSources.push("medication");
        return rows;
      })
    : [];
  for (const med of meds) {
    legacy(
      `med:${med.id}`,
      // A search title is a short label a host renders in a result list,
      // so it is scrubbed rather than fenced — wrapping it would leak
      // markers into the host's UI. Scrubbing still denies a hostile
      // name the ability to forge a boundary around neighbouring text.
      scrubFenceMarkers(med.dose ? `${med.name} ${med.dose}` : med.name),
      // Per-item deep-link to the medication detail page (mirrors `fetch`).
      `${origin}/medications/${encodeURIComponent(med.id)}`,
      med.name,
    );
  }

  const labs = labsOn
    ? await capped(SEARCH_RESULT_SCAN_CAP, (take) =>
        prisma.labResult.findMany({
          where: { userId: ctx.userId, deletedAt: null },
          select: { analyte: true },
          distinct: ["analyte"],
          // One row per analyte, so the analyte alone is a total order.
          orderBy: { analyte: "asc" },
          take,
        }),
      ).then(({ rows, cap }) => {
        if (cap.truncated) truncatedSources.push("lab");
        return rows;
      })
    : [];
  for (const lab of labs) {
    legacy(
      `lab:${lab.analyte}`,
      // Document-sourced free text — scrubbed, same reasoning as the
      // medication titles above.
      scrubFenceMarkers(lab.analyte),
      // Per-item deep-link to the labs surface filtered to this analyte.
      `${origin}/labs?analyte=${encodeURIComponent(lab.analyte)}`,
      lab.analyte,
    );
  }
}

/** The clinical signals and metric-status-only series the record holds. */
async function addSignalCandidates(
  ctx: McpAuthContext,
  origin: string,
  legacy: AddCandidate,
): Promise<void> {
  // The clinical signals (grip strength, pain NRS, waist / WHtR) PLUS
  // the metric-status-only set (wrist
  // temperature, cardio recovery, sleep score, breathing disturbances,
  // strain/load, …) — both sit off the Coach data inventory by design,
  // so they are surfaced here directly. One grouped presence probe over
  // the combined backing measurement types; present-only, in a stable
  // (allowlist) order. `fetch metric:<KEY>` hydrates each via the
  // rollup-backed baseline read. A signal whose owning module
  // is off is dropped, the way `list_metrics` already drops it.
  const discoverableSignals = [
    ...MCP_CLINICAL_SIGNALS,
    ...MCP_METRIC_STATUS_DISCOVERY,
  ];
  // Live rows only: a deleted reading is not a signal the
  // record holds, and the filter lets the probe use the live-rows
  // partial index instead of walking the tombstones.
  // A presence probe is one index lookup per type (`readLatestEver`
  // drops a type with no live reading), not a grouping of every row.
  const discoverablePresent = await readLatestEver(
    prisma,
    ctx.userId,
    discoverableSignals.map((s) => s.measurementType),
  );
  const presentTypes = new Set(discoverablePresent.map((r) => r.type));
  for (const sig of discoverableSignals) {
    if (!presentTypes.has(sig.measurementType)) continue;
    const owner = moduleForMeasurementType(sig.measurementType);
    if (owner && !(await isModuleEnabled(ctx.userId, owner))) continue;
    legacy(
      `metric:${sig.key}`,
      sig.label,
      `${origin}/insights?metric=${encodeURIComponent(sig.key)}`,
      `${sig.label} ${sig.key}`,
    );
  }
}

/** The nutrients the record holds, behind the `nutrients` module. */
async function addNutrientCandidates(
  ctx: McpAuthContext,
  origin: string,
  legacy: AddCandidate,
): Promise<void> {
  // Nutrients (water/caffeine/24 micronutrients) presence
  // probe, gated on the opt-in `nutrients` module exactly like the
  // ingest/read routes: an account that never turned the module on gets
  // no rows here, mirroring the module's own dark-by-default posture.
  // One grouped presence query over the closed catalog, mirroring the
  // clinical-signal probe above. Without this, `search("water")` /
  // `search("magnesium")` returned `[]` even for a daily logger — a
  // truthfulness bug under the server's own absence contract.
  if (await isModuleEnabled(ctx.userId, "nutrients")) {
    const nutrientPresent = await prisma.nutrientIntakeDay.groupBy({
      by: ["nutrient"],
      where: { userId: ctx.userId },
    });
    const loggedNutrients = new Set(nutrientPresent.map((r) => r.nutrient));
    for (const code of NUTRIENT_CODES) {
      if (!loggedNutrients.has(code)) continue;
      const label = NUTRIENT_LABELS[code];
      legacy(
        `nutrient:${code}`,
        label,
        `${origin}/insights/nutrients`,
        `${label} ${code} nutrient nutrients`,
      );
    }
  }
}

/** The ranked page of an assembled search, and what it could not reach. */
function searchPage(
  { candidates, truncatedSources }: SearchAssembly,
  rawQuery: string,
  cursor: unknown,
) {
  const results = rankCandidates(candidates, rawQuery).map(
    ({ id, title, url }) => ({ id, title, url }),
  );

  // Cursor pagination over the ranked result set. The set is rebuilt
  // and ranked deterministically each call, so an opaque offset cursor
  // pages it reliably and the response stays token-bounded.
  const offset = decodeOffsetCursor(cursor);
  const page = results.slice(offset, offset + SEARCH_PAGE_SIZE);
  const hasMore = offset + SEARCH_PAGE_SIZE < results.length;
  annotate({
    action: { name: "mcp.tool.invoked" },
    meta: { tool: "search", present: page.length > 0 },
  });
  return {
    results: page,
    ...(hasMore
      ? { nextCursor: encodeOffsetCursor(offset + SEARCH_PAGE_SIZE) }
      : {}),
    // Every page says so, not only the last: the cut is in what was
    // searched, which no cursor reaches past.
    truncated: truncatedSources.length > 0,
    ...(truncatedSources.length > 0
      ? { truncatedSources: [...new Set(truncatedSources)].sort() }
      : {}),
  };
}

/**
 * The `search` + `fetch` pair — the de-facto two-tool retrieval convention and,
 * critically, the ONLY tools ChatGPT can call in its default (non-Developer)
 * mode. Without them HealthLog is invisible in default ChatGPT. The exact wire
 * shapes are mandated by OpenAI:
 *
 *   - `search({ query })` → `{ results: [{ id, title, url }] }`
 *   - `fetch({ id })`     → `{ id, title, text, url, metadata? }`
 *
 * Every result carries a REAL, user-openable HTTPS deep link (`url`) into the
 * HealthLog web app — ChatGPT only creates citation metadata when `url` is a
 * non-empty string. The internal `id` stays separate from `url`. Both tools are
 * thin façades over the SAME server-authoritative read paths the other tools
 * use; free-text fields (medication names, lab analytes) are returned as DATA,
 * never interpreted as instructions (R-SEC-2).
 */
export const searchTool: McpToolDefinition = {
  name: "search",
  title: "Search your health records",
  description:
    "Search the user's own health record for items matching a free-text query (English or the user's language). Covers metric domains, medications, lab biomarkers, and the clinical records: doctor visits including procedures and surgeries (`visit:<id>`, matched on visit kind, reason, outcome, body site and side, practitioner name and specialty), conditions (`condition:<id>`, matched on label, type, body site and side), documents (`document:<id>`, matched on title, file name, kind such as discharge letter, and whole words of the document's own indexed text where one is stored; a document the user held back from AI reading is matched on its title and details only) and vaccinations (`vaccination:<id>`, matched on vaccine name and catalogue name). Condition and vaccination notes are never searched or returned. A kind whose module the user has switched off (conditions, documents, vaccinations, medications, labs) never appears. Results are ranked by how many query words match, then newest first; record results are capped at 50. Returns { results: [{ id, title, url }], nextCursor? }; pass an id to the `fetch` tool to hydrate it. Each `url` deep-links into the HealthLog web app for citation. When more results exist, pass the opaque `nextCursor` back as `cursor` for the next page. Returns an empty list when nothing matches.",
  inputShape: {
    query: z.string().max(200),
    cursor: z
      .string()
      .max(256)
      .optional()
      .describe(
        "Opaque pagination cursor from a previous response's nextCursor. Treat as a black box; do not construct one.",
      ),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: {
    results: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        url: z.string(),
      }),
    ),
    nextCursor: z.string().optional(),
    truncated: cappedOutput.truncated.describe(
      "True when a source this search reads stopped at its scan ceiling, so older records of that kind were not searched and no cursor reaches them. An empty or short result is then not proof that nothing matches; narrow the query or use the kind's own tool.",
    ),
    truncatedSources: z
      .array(z.string())
      .optional()
      .describe(
        "Which sources were cut: medication, lab, visit, condition, document, vaccination.",
      ),
  },
  async run(ctx, args) {
    const rawQuery = typeof args.query === "string" ? args.query.trim() : "";
    const origin = resolveBaseOrigin();
    const assembly = startAssembly();
    await addInventoryCandidates(ctx, origin, assembly.legacy);
    await addMedicationAndLabCandidates(ctx, origin, assembly);
    await addSignalCandidates(ctx, origin, assembly.legacy);
    await addNutrientCandidates(ctx, origin, assembly.legacy);

    // Visits (procedures included), conditions, documents and
    // vaccinations, each behind its own module switch.
    assembly.candidates.push(
      ...(await loadRecordCandidates(ctx.userId, rawQuery, origin, {
        onTruncated: (kind) => assembly.truncatedSources.push(kind),
      })),
    );

    return searchPage(assembly, rawQuery, args.cursor);
  },
};

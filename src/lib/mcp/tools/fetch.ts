import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { isModuleEnabled } from "@/lib/modules/gate";
import { resolveBaseOrigin } from "@/lib/mcp/oauth/config";
import {
  getMetricBaseline,
  MCP_CLINICAL_SIGNALS,
  MCP_METRIC_STATUS_DISCOVERY,
} from "@/lib/mcp/rich-reads";
import {
  getNutrients,
  resolveNutrientCode,
  NUTRIENT_LABELS,
  type NutrientsDailyResult,
} from "@/lib/mcp/nutrients-read";
import { fenceUserText, scrubFenceMarkers } from "@/lib/ai/coach/data-fence";
import {
  fetchRecord,
  isRecordKind,
  type FetchResult,
} from "@/lib/mcp/record-search";
import { labResultLinks, readLatestLabs } from "@/lib/mcp/lab-reads";
import {
  boundLinks,
  linksBySource,
  linksSentence,
  MEDICATION_LINK_TARGETS,
} from "@/lib/mcp/record-links";
import {
  plainClinicalText,
  plainLabText,
  plainMetricText,
  plainNutrientText,
} from "./render/citation-text";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

/** The lab result id of the reading `plainLabText` quotes, when it has one. */
function latestLabId(result: unknown): string | null {
  const r = result as { present?: boolean; data?: { recent?: unknown[] } };
  const first = r?.present && Array.isArray(r.data?.recent) && r.data.recent[0];
  const id = first ? (first as { id?: unknown }).id : undefined;
  return typeof id === "string" ? id : null;
}

/** `fetch lab:<analyte>`: the latest reading, with what it is linked to. */
async function fetchLab(
  userId: string,
  id: string,
  rid: string,
  origin: string,
): Promise<FetchResult> {
  const result = await readLatestLabs(userId, rid, () =>
    executeCoachTool({
      userId,
      name: "get_labs",
      rawArguments: JSON.stringify({ analyte: rid }),
    }),
  );
  // The links of the reading the text quotes, the latest one.
  const latestId = latestLabId(result);
  const linked = latestId ? await labResultLinks(userId, latestId) : null;
  return {
    id,
    title: rid,
    text:
      plainLabText(rid, result) +
      (linked ? ` ${linksSentence(linked.links)}` : ""),
    // Deep-link to the labs surface filtered to this analyte.
    url: `${origin}/labs?analyte=${encodeURIComponent(rid)}`,
    metadata: { type: "lab", analyte: rid, ...linked },
  };
}

/** `fetch med:<id>`: the medication, with what it is linked to. */
async function fetchMedication(
  userId: string,
  id: string,
  rid: string,
  origin: string,
): Promise<FetchResult> {
  const med = await prisma.medication.findFirst({
    where: { id: rid, userId },
    select: {
      name: true,
      dose: true,
      treatmentClass: true,
      asNeeded: true,
    },
  });
  if (!med) {
    return {
      id,
      title: "Not found",
      text: "No medication matches this id.",
      url: `${origin}/medications`,
      metadata: { type: "medication" },
    };
  }
  // Plain-text prose, not a JSON blob. `name` / `dose` /
  // `treatmentClass` are user-controlled free text returned as DATA,
  // never interpreted — fenced so that contract is stated on the wire
  // rather than only in the server instructions.
  const text = fenceUserText(
    `${med.name}${med.dose ? ` ${med.dose}` : ""}` +
      `${med.asNeeded ? " (as needed)" : ""}` +
      `${med.treatmentClass ? ` — ${med.treatmentClass}` : ""}.`,
  );
  const linked = await linksBySource(
    userId,
    "medication",
    [rid],
    MEDICATION_LINK_TARGETS,
  );
  const { links, linksTruncated } = boundLinks(linked.get(rid) ?? []);
  return {
    id,
    title: scrubFenceMarkers(med.name),
    text: `${text} ${linksSentence(links)}`,
    // Per-item deep-link to the medication detail page.
    url: `${origin}/medications/${encodeURIComponent(rid)}`,
    metadata: {
      type: "medication",
      medicationId: rid,
      links,
      linksTruncated,
    },
  };
}

/**
 * `fetch`, the second half of the `search` + `fetch` pair (see `search.ts`
 * for the wire shapes ChatGPT mandates): hydrates one id into a plain-text
 * citation with a deep link into the HealthLog web app.
 */
export const fetchTool: McpToolDefinition = {
  name: "fetch",
  title: "Fetch one health record",
  description:
    'Hydrate a single record returned by `search`, by its id (e.g. `metric:weight`, `med:<id>`, `lab:LDL`, `visit:<id>`, `condition:<id>`, `document:<id>`, `vaccination:<id>`). Returns { id, title, text, url, metadata } where `text` is a server-authoritative, plain-text prose summary suitable for citation and `url` deep-links to the specific record in HealthLog. A visit, condition, document, vaccination, lab or medication carries its key fields and its directly linked records (metadata.links, each with an id `fetch` accepts, a label and a date, at most 25 with metadata.linksTruncated, and \"Linked records: none.\" in the text when there are none); a linked document imported from Paperless-ngx or Papra also names its sourceSystem and sourceId (never an address), and a document is listed only while the Documents module is on. A lab lists the links of its latest reading (the report it was read from, the visits it is filed against); a medication its conditions, documents and visits; a document also lists the lab results read from it and the medications filed against it; a document returns its metadata and at most a bounded excerpt of its own indexed text (the words of the stored document), never the file; a document held back from AI reading returns no excerpt and metadata.reason \"ai_read_deferred\". Fields that were never recorded are null. Returns a not-found message when the id does not resolve, and metadata.reason "module_disabled" when the record\'s module is switched off.',
  inputShape: { id: z.string().min(1).max(200) },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: {
    id: z.string(),
    title: z.string(),
    text: z.string(),
    url: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  },
  async run(ctx, args) {
    const id = typeof args.id === "string" ? args.id : "";
    const origin = resolveBaseOrigin();
    const sep = id.indexOf(":");
    const kind = sep > 0 ? id.slice(0, sep) : "";
    const rid = sep > 0 ? id.slice(sep + 1) : "";

    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "fetch", kind: kind || "unknown" },
    });

    if (kind === "metric" && rid) {
      // The clinical signals AND the metric-status-only discovery
      // set both sit off the Coach snapshot, so hydrate them through the
      // rollup-backed baseline read rather than the Coach
      // `get_metric_series` path (which would report no data for them).
      const discoverable = [
        ...MCP_CLINICAL_SIGNALS,
        ...MCP_METRIC_STATUS_DISCOVERY,
      ].find((s) => s.key.toLowerCase() === rid.toLowerCase());
      if (discoverable) {
        const baseline = await getMetricBaseline(ctx.userId, {
          metric: discoverable.key,
        });
        return {
          id,
          title: discoverable.label,
          text: plainClinicalText(discoverable.label, baseline),
          url: `${origin}/insights?metric=${encodeURIComponent(discoverable.key)}`,
          metadata: { type: "metric", metric: discoverable.key },
        };
      }
      const result = await executeCoachTool({
        userId: ctx.userId,
        sourceSnapshot: true,
        name: "get_metric_series",
        rawArguments: JSON.stringify({ metric: rid }),
      });
      return {
        id,
        title: rid,
        text: plainMetricText(rid, result),
        // The metric page deep-link; the insights surface renders the series.
        url: `${origin}/insights?metric=${encodeURIComponent(rid)}`,
        metadata: { type: "metric", metric: rid },
      };
    }

    if (kind === "nutrient" && rid) {
      const code = resolveNutrientCode(rid);
      if (!code) {
        return {
          id,
          title: "Not found",
          text: `No nutrient matches "${rid}".`,
          url: `${origin}/insights/nutrients`,
          metadata: { type: "nutrient" },
        };
      }
      const result = (await getNutrients(ctx.userId, {
        nutrient: code,
      })) as NutrientsDailyResult;
      const label = NUTRIENT_LABELS[code];
      return {
        id,
        title: label,
        text: plainNutrientText(label, result),
        url: `${origin}/insights/nutrients`,
        metadata: { type: "nutrient", nutrient: code },
      };
    }

    // A switched-off module answers as switched off, before
    // any row is read, the way the record kinds below do.
    const gatedModule =
      kind === "lab" ? "labs" : kind === "med" ? "medications" : null;
    if (
      gatedModule &&
      rid &&
      !(await isModuleEnabled(ctx.userId, gatedModule))
    ) {
      return {
        id,
        title: "Not available",
        text: `This record kind is switched off in HealthLog (module "${gatedModule}"), so nothing of it is shared.`,
        url: `${origin}/insights`,
        metadata: {
          type: kind === "lab" ? "lab" : "medication",
          present: false,
          reason: "module_disabled",
        },
      };
    }

    if (kind === "lab" && rid) return fetchLab(ctx.userId, id, rid, origin);

    if (kind === "med" && rid) {
      return fetchMedication(ctx.userId, id, rid, origin);
    }

    if (isRecordKind(kind) && rid) {
      return fetchRecord(ctx.userId, kind, rid, origin);
    }

    return {
      id,
      title: "Not found",
      text: `No record matches the id "${id}".`,
      url: `${origin}/insights`,
      metadata: { type: "unknown" },
    };
  },
};

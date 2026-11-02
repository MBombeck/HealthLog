/**
 * The one-hop links an MCP read lists beside a record: `fetch` on a visit,
 * condition, document, vaccination, lab or medication, and the lab and
 * medication list reads. One builder, so every read names a linked record the
 * same way: an id `fetch` accepts, a label, a date, and for an imported
 * document the system it came from and its id there.
 *
 * Reads go through the link service only (`@/lib/links`), which narrows the
 * link rows AND the targets to the caller's account, so another account's
 * record cannot appear here. A target kind whose module is switched off is not
 * read at all, the way `fetch` has always treated a switched-off kind.
 *
 * Labels are the person's own words (a document title, an analyte, a
 * medication name): scrubbed of forged fence markers in structured fields, and
 * fenced in the prose sentence.
 */
import type { EncounterKind } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { fenceUserText, scrubFenceMarkers } from "@/lib/ai/coach/data-fence";
import { encounterKindLabel } from "@/lib/encounters/kind-label";
import { listTargetsBySource } from "@/lib/links";
import type {
  LinkSourceKind,
  LinkTargetKind,
  LinkedTarget,
} from "@/lib/links/link-service";
import { isModuleEnabled, type ModuleKey } from "@/lib/modules/gate";
import {
  toDocumentSourceSystem,
  type DocumentSourceSystemValue,
} from "@/lib/validations/inbound-documents";

/** One-hop links one record lists. */
export const MAX_LINKS = 25;

/** What a medication lists as linked, in this order. */
export const MEDICATION_LINK_TARGETS = [
  "conditionEpisode",
  "document",
  "encounter",
] as const;

export type RecordLinkKind =
  "visit" | "condition" | "document" | "vaccination" | "lab" | "medication";

export interface RecordLink {
  id: string | null;
  kind: RecordLinkKind;
  label: string;
  date: string | null;
  /**
   * For a document imported from Paperless-ngx or Papra: the system and the
   * document's id there. Never the instance address.
   */
  sourceSystem?: DocumentSourceSystemValue;
  sourceId?: string;
}

/** The module each link target belongs to; a visit belongs to none. */
const TARGET_MODULE: Record<LinkTargetKind, ModuleKey | null> = {
  encounter: null,
  document: "inboundDocuments",
  conditionEpisode: "illness",
  labResult: "labs",
  medication: "medications",
  vaccination: "vaccinations",
};

/** The link kind and the `fetch` id prefix of each target kind. */
const TARGET_LINK: Record<
  Exclude<LinkTargetKind, "labResult">,
  { kind: RecordLinkKind; prefix: string }
> = {
  encounter: { kind: "visit", prefix: "visit" },
  document: { kind: "document", prefix: "document" },
  conditionEpisode: { kind: "condition", prefix: "condition" },
  medication: { kind: "medication", prefix: "med" },
  vaccination: { kind: "vaccination", prefix: "vaccination" },
};

function linkDate(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

/** A linked visit is labelled by its kind, in English on this wire. */
function visitLinkLabel(target: LinkedTarget): string {
  return encounterKindLabel(target.label as EncounterKind, "en");
}

/** A lab result is fetched by its analyte, so the link id names that. */
async function labLinks(
  userId: string,
  targets: readonly LinkedTarget[],
): Promise<Map<string, RecordLink>> {
  // Asked here as well as by every caller: an analyte name is lab data.
  if (!(await isModuleEnabled(userId, "labs"))) return new Map();
  const rows = await prisma.labResult.findMany({
    where: { userId, id: { in: targets.map((t) => t.id) }, deletedAt: null },
    select: { id: true, analyte: true },
  });
  const analyte = new Map(rows.map((r) => [r.id, r.analyte]));
  const out = new Map<string, RecordLink>();
  for (const target of targets) {
    const name = analyte.get(target.id);
    if (!name) continue;
    out.set(target.id, {
      id: `lab:${name}`,
      kind: "lab",
      label: scrubFenceMarkers(target.label),
      date: linkDate(target.date),
    });
  }
  return out;
}

/** An imported document says where it came from: system and id, no address. */
async function documentSources(
  userId: string,
  targets: readonly LinkedTarget[],
): Promise<Map<string, Pick<RecordLink, "sourceSystem" | "sourceId">>> {
  const rows = await prisma.inboundDocument.findMany({
    where: { userId, id: { in: targets.map((t) => t.id) } },
    select: { id: true, sourceSystem: true, sourceId: true },
  });
  const out = new Map<string, Pick<RecordLink, "sourceSystem" | "sourceId">>();
  for (const row of rows) {
    const system = toDocumentSourceSystem(row.sourceSystem);
    if (system && row.sourceId) {
      out.set(row.id, {
        sourceSystem: system,
        sourceId: scrubFenceMarkers(row.sourceId),
      });
    }
  }
  return out;
}

/** Resolve one target kind's targets into links, keyed by target id. */
async function resolveLinks(
  userId: string,
  targetKind: LinkTargetKind,
  targets: readonly LinkedTarget[],
): Promise<Map<string, RecordLink>> {
  if (targets.length === 0) return new Map();
  if (targetKind === "labResult") return labLinks(userId, targets);
  const { kind, prefix } = TARGET_LINK[targetKind];
  const sources =
    targetKind === "document"
      ? await documentSources(userId, targets)
      : new Map<string, Pick<RecordLink, "sourceSystem" | "sourceId">>();
  return new Map(
    targets.map((target) => [
      target.id,
      {
        id: `${prefix}:${target.id}`,
        kind,
        label: scrubFenceMarkers(
          targetKind === "encounter" ? visitLinkLabel(target) : target.label,
        ),
        date: linkDate(target.date),
        ...sources.get(target.id),
      },
    ]),
  );
}

/** Links for targets already read by the caller, in their order. */
export async function linksFor(
  userId: string,
  targetKind: LinkTargetKind,
  targets: readonly LinkedTarget[],
): Promise<RecordLink[]> {
  const resolved = await resolveLinks(userId, targetKind, targets);
  return targets.flatMap((t) => resolved.get(t.id) ?? []);
}

/** The target kinds whose module is on for this account, in order. */
export async function visibleTargetKinds(
  userId: string,
  kinds: readonly LinkTargetKind[],
): Promise<LinkTargetKind[]> {
  const on = await Promise.all(
    kinds.map((kind) => {
      const owner = TARGET_MODULE[kind];
      return owner ? isModuleEnabled(userId, owner) : true;
    }),
  );
  return kinds.filter((_, i) => on[i]);
}

/**
 * The links of many sources at once, keyed by source id, unbounded (bound
 * them per record with {@link boundLinks}). One link read and one target read
 * per target kind for the whole set, so a list of readings costs the same few
 * round trips as one. A source with no link maps to an empty list.
 */
export async function linksBySource(
  userId: string,
  sourceKind: LinkSourceKind,
  sourceIds: readonly string[],
  targetKinds: readonly LinkTargetKind[],
): Promise<Map<string, RecordLink[]>> {
  const out = new Map<string, RecordLink[]>(sourceIds.map((id) => [id, []]));
  if (sourceIds.length === 0) return out;
  const visible = await visibleTargetKinds(userId, targetKinds);
  const perKind = await Promise.all(
    visible.map(async (targetKind) => {
      const bySource = await listTargetsBySource(prisma, {
        userId,
        sourceKind,
        sourceIds: [...sourceIds],
        targetKind,
      });
      const resolved = await resolveLinks(
        userId,
        targetKind,
        [...bySource.values()].flat(),
      );
      return { bySource, resolved };
    }),
  );
  for (const { bySource, resolved } of perKind) {
    for (const [sourceId, targets] of bySource) {
      const list = out.get(sourceId);
      if (!list) continue;
      list.push(...targets.flatMap((t) => resolved.get(t.id) ?? []));
    }
  }
  return out;
}

/** The prose form of a record's links, with the same empty answer everywhere. */
export function linksSentence(links: readonly RecordLink[]): string {
  if (links.length === 0) return "Linked records: none.";
  return `Linked records: ${links
    .map((l) => {
      const detail = [
        l.date,
        l.sourceSystem && l.sourceId
          ? `${l.sourceSystem} id ${fenceUserText(l.sourceId)}`
          : null,
      ].filter((d): d is string => d !== null);
      return `${l.kind} ${fenceUserText(l.label)}${
        detail.length > 0 ? ` (${detail.join(", ")})` : ""
      }`;
    })
    .join("; ")}.`;
}

export function boundLinks(links: readonly RecordLink[]): {
  links: RecordLink[];
  linksTruncated: boolean;
} {
  return {
    links: links.slice(0, MAX_LINKS),
    linksTruncated: links.length > MAX_LINKS,
  };
}

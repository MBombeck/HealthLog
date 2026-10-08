/**
 * Life events: the record's own dated anchors (v1.42, #613).
 *
 * A move, a birth, a new job, a loss. Title and note are encrypted at rest
 * (`titleEncrypted`, `noteEncrypted`, registered for key rotation) and are
 * decrypted only for the session that resolved the record. They are part of
 * the `profile` sharing domain and never reach a model: the day's model
 * projection drops them and no Coach or MCP read touches this table.
 *
 * Dates are calendar dates without a zone, aligned to their precision: at
 * MONTH a date is the first of its month, at YEAR the first of its year
 * (`lifeEventCreateSchema`). An edit is merged onto the stored row and the
 * merged event is checked against the create rules again, because changing
 * the precision alone can misalign a date the edit does not carry.
 */
import type { z } from "zod/v4";

import type { LifeEvent, Prisma } from "@/generated/prisma/client";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import type {
  LifeEventCreateInput,
  LifeEventDTO,
  LifeEventUpdateInput,
} from "@/lib/day/contract";
import { lifeEventCreateSchema } from "@/lib/day/wire-schemas";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";

type LifeEventRow = Pick<
  LifeEvent,
  | "id"
  | "category"
  | "startDate"
  | "endDate"
  | "precision"
  | "titleEncrypted"
  | "noteEncrypted"
  | "createdAt"
  | "updatedAt"
>;

function open(buf: Uint8Array | null, field: "title" | "note"): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decryptFromBytes(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `life event ${field} decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export function toLifeEventDTO(row: LifeEventRow): LifeEventDTO {
  return {
    id: row.id,
    category: row.category,
    startDate: row.startDate,
    endDate: row.endDate,
    precision: row.precision,
    title: open(row.titleEncrypted, "title"),
    note: open(row.noteEncrypted, "note"),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The record's live life events, oldest first. */
export async function listLifeEvents(userId: string): Promise<LifeEventDTO[]> {
  const rows = await prisma.lifeEvent.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toLifeEventDTO);
}

/** Field by field, never a spread of the parsed body. */
export async function createLifeEvent(
  userId: string,
  input: LifeEventCreateInput,
): Promise<LifeEvent> {
  const note = input.note ?? null;
  return prisma.lifeEvent.create({
    data: {
      userId,
      category: input.category,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      precision: input.precision,
      titleEncrypted: encryptToBytes(input.title),
      noteEncrypted: note ? encryptToBytes(note) : null,
    },
  });
}

/** A live life event of this record, or null for a foreign or deleted id. */
export async function findOwnLifeEvent(
  userId: string,
  id: string,
): Promise<LifeEvent | null> {
  const row = await prisma.lifeEvent.findUnique({ where: { id } });
  if (!row || row.userId !== userId || row.deletedAt !== null) return null;
  return row;
}

export type LifeEventMergeResult =
  | { ok: true; data: Prisma.LifeEventUpdateInput }
  | { ok: false; error: z.ZodError };

/**
 * Merge an edit onto the stored row and check the result against the create
 * rules. Only the keys the edit carries are written; the stored title is
 * checked through its plaintext, which the merge needs to validate anyway.
 */
export function mergeLifeEventEdit(
  existing: LifeEvent,
  edit: LifeEventUpdateInput,
): LifeEventMergeResult {
  const merged = {
    category: edit.category ?? existing.category,
    startDate: edit.startDate ?? existing.startDate,
    endDate: edit.endDate === undefined ? existing.endDate : edit.endDate,
    precision: edit.precision ?? existing.precision,
    title: edit.title ?? open(existing.titleEncrypted, "title") ?? "",
    note:
      edit.note === undefined
        ? open(existing.noteEncrypted, "note")
        : edit.note,
  };
  const checked = lifeEventCreateSchema.safeParse(merged);
  if (!checked.success) return { ok: false, error: checked.error };

  const data: Prisma.LifeEventUpdateInput = {};
  if (edit.category !== undefined) data.category = edit.category;
  if (edit.startDate !== undefined) data.startDate = edit.startDate;
  if (edit.endDate !== undefined) data.endDate = edit.endDate;
  if (edit.precision !== undefined) data.precision = edit.precision;
  if (edit.title !== undefined) {
    data.titleEncrypted = encryptToBytes(checked.data.title);
  }
  if (edit.note !== undefined) {
    const note = checked.data.note ?? null;
    data.noteEncrypted = note ? encryptToBytes(note) : null;
  }
  return { ok: true, data };
}

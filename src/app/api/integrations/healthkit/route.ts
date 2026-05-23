/**
 * HealthKit (iOS) integration config.
 *
 * Persisted on `User.healthKitConfigJson` as `{ entries: [...] }`.
 * Each entry: `{ id, kind, direction, enabled }` where `direction` is one
 * of `bidirectional | readOnly | writeOnly`.
 *
 * GET   → resolved config (with default entries when nothing is stored).
 * PATCH → merge by `id`; unknown ids are silently ignored.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma, toJson } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";

export const directionEnum = z.enum([
  "bidirectional",
  "readOnly",
  "writeOnly",
  "disabled",
]);

const entrySchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.string().min(1).max(64).optional(),
  direction: directionEnum,
  enabled: z.boolean().optional(),
});

const patchSchema = z.object({
  entries: z.array(entrySchema).max(50),
});

export interface HealthKitEntry {
  id: string;
  kind: string;
  direction: z.infer<typeof directionEnum>;
  enabled: boolean;
}

export const DEFAULT_HEALTHKIT_ENTRIES: HealthKitEntry[] = [
  {
    id: "bodyMass",
    kind: "bodyMass",
    direction: "bidirectional",
    enabled: true,
  },
  {
    id: "bp",
    kind: "bloodPressure",
    direction: "bidirectional",
    enabled: true,
  },
  {
    id: "glucose",
    kind: "bloodGlucose",
    direction: "bidirectional",
    enabled: true,
  },
  { id: "heartRate", kind: "heartRate", direction: "readOnly", enabled: true },
  { id: "stepCount", kind: "stepCount", direction: "readOnly", enabled: true },
  { id: "sleep", kind: "sleepAnalysis", direction: "readOnly", enabled: true },
];

interface StoredConfig {
  entries: HealthKitEntry[];
}

function parseStored(json: unknown): StoredConfig | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const entries = obj.entries;
  if (!Array.isArray(entries)) return null;
  const out: HealthKitEntry[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : null;
    const kind = typeof e.kind === "string" ? e.kind : id;
    const directionRaw = typeof e.direction === "string" ? e.direction : null;
    if (!id || !kind || !directionRaw) continue;
    const dir = directionEnum.safeParse(directionRaw);
    if (!dir.success) continue;
    out.push({
      id,
      kind,
      direction: dir.data,
      enabled: typeof e.enabled === "boolean" ? e.enabled : true,
    });
  }
  return { entries: out };
}

function mergeWithDefaults(stored: StoredConfig | null): HealthKitEntry[] {
  const map = new Map<string, HealthKitEntry>();
  for (const def of DEFAULT_HEALTHKIT_ENTRIES) {
    map.set(def.id, { ...def });
  }
  if (stored) {
    for (const entry of stored.entries) {
      const existing = map.get(entry.id);
      if (existing) {
        map.set(entry.id, { ...existing, ...entry });
      } else {
        // Surface custom keys the user has added.
        map.set(entry.id, { ...entry, enabled: entry.enabled ?? true });
      }
    }
  }
  return [...map.values()];
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "integrations.healthkit.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { healthKitConfigJson: true, healthKitLastSyncedAt: true },
  });

  const stored = parseStored(row?.healthKitConfigJson ?? null);
  const entries = mergeWithDefaults(stored);

  return apiSuccess({
    entries,
    lastSyncedAt: row?.healthKitLastSyncedAt?.toISOString() ?? null,
  });
});

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error } = await safeJson(request);
  if (error) return error;

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — iOS HealthKit ingest is a hot path. Multi-issue
    // 422 + audit breadcrumb so the iOS Sync engine sees the full
    // diff and stops iterating one field at a time.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "integrations.healthkit.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row; the
    // HealthKit patch payload carries caller-provided `id` + `kind`
    // strings that Zod can echo.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "integrations.healthkit.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422);
  }

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { healthKitConfigJson: true },
  });
  const stored = parseStored(row?.healthKitConfigJson ?? null);

  // Resolve known ids set: default ids + already-stored ids.
  const knownIds = new Set<string>(DEFAULT_HEALTHKIT_ENTRIES.map((e) => e.id));
  if (stored) for (const e of stored.entries) knownIds.add(e.id);

  // Merge by id; unknown ids are silently ignored per spec.
  const map = new Map<string, HealthKitEntry>();
  if (stored) for (const e of stored.entries) map.set(e.id, e);
  for (const update of parsed.data.entries) {
    if (!knownIds.has(update.id)) continue;
    const existing =
      map.get(update.id) ??
      DEFAULT_HEALTHKIT_ENTRIES.find((d) => d.id === update.id);
    map.set(update.id, {
      id: update.id,
      kind: update.kind ?? existing?.kind ?? update.id,
      direction: update.direction,
      enabled: update.enabled ?? existing?.enabled ?? true,
    });
  }

  const updatedConfig: StoredConfig = { entries: [...map.values()] };

  await prisma.user.update({
    where: { id: user.id },
    data: {
      healthKitConfigJson: toJson(updatedConfig),
    },
  });

  await auditLog("integrations.healthkit.update", {
    userId: user.id,
    details: { count: updatedConfig.entries.length },
  });

  annotate({
    action: { name: "integrations.healthkit.update" },
    meta: { count: updatedConfig.entries.length },
  });

  // Return resolved config (defaults merged) so the client always sees a
  // complete entries list.
  const merged = mergeWithDefaults(updatedConfig);
  return apiSuccess({
    entries: merged,
    lastSyncedAt: null,
  });
});

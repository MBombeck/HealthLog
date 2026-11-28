/**
 * v1.11.0 — shared helpers for the read-only FHIR R4 REST face.
 *
 * The `GET /api/fhir/*` search routes are thin: each resolves the caller's own
 * `DoctorReportData` (the SAME aggregator the PDF + document export consume),
 * runs the matching shared emitter from `./resources`, then wraps the result
 * in a `type: "searchset"` Bundle via the helpers here. Keeping the bundling,
 * paging, content-type and `OperationOutcome` shaping in one place means every
 * resource endpoint answers identically.
 *
 * Read-only: there are no write handlers anywhere under `/api/fhir`. Auth is a
 * narrow `fhir:read` Bearer scope (cookie sessions also pass); `userId` is
 * always narrowed from the auth context, never accepted from the wire.
 */
import { NextResponse } from "next/server";

import {
  INSURANCE_IDENTITY_SELECT,
  readInsuranceIdentity,
} from "@/lib/profile/insurance-identity";
import { resolveSavedSelection } from "@/lib/report-selection/saved-profile";
import { prisma } from "@/lib/db";
import {
  collectDoctorReportData,
  normaliseDateRange,
  type DoctorReportData,
} from "@/lib/doctor-report-data";
import type { FhirRecordInputs } from "@/lib/fhir/build-bundle";
import type { FhirPatientIdentity } from "@/lib/fhir/resources/common";
import { GERMAN_ATC_DEFAULT_LOCALES } from "@/lib/fhir/resources";
import { isModuleEnabled, resolveModuleMap } from "@/lib/modules/gate";
import { resolveReportGate } from "@/lib/doctor-report/selection-gate";
import {
  resolveSeriesScope,
  seriesGlucoseUnit,
  type SeriesCodeFilter,
  type SeriesScope,
} from "@/lib/fhir/series";
import type { GlucoseUnit } from "@/lib/glucose";
import { toAllergyDTO, toFamilyHistoryEntryDTO } from "@/lib/records/dto";
import type {
  FhirBundleEntry,
  FhirBundleLink,
  FhirOperationOutcome,
  FhirResource,
  FhirSearchsetBundle,
} from "@/lib/fhir/types";

/** The Bearer scope a narrow-scoped token must carry to read the FHIR face. */
export const FHIR_READ_SCOPE = "fhir:read";

/**
 * Canonical catalogue of FHIR R4 resource types the read-only REST face serves
 * (`read` + `search-type` interactions only — no write, ever). One source of
 * truth: the `metadata` CapabilityStatement, the `/api/meta/capabilities`
 * discovery surface, and the share-link resource-type enum all derive from
 * this so the advertised set can never drift from what is actually routed.
 */
export const FHIR_REST_RESOURCE_TYPES = [
  "Patient",
  "Coverage",
  "Observation",
  "MedicationStatement",
  "MedicationAdministration",
] as const;

/**
 * The whole-record operation the REST face exposes
 * (`GET /api/fhir/Patient/$everything`). It returns a `type: "searchset"`
 * Bundle carrying every resource the document export carries, entry-for-entry,
 * under the same `urn:uuid` identities — so a reference between two of them
 * still resolves inside the response. Surfaced in discovery so a client knows
 * the snapshot pull exists alongside the per-resource searches.
 */
export const FHIR_EVERYTHING_OPERATION = "$everything";

/** Search parameters honoured uniformly across the search routes. */
export const FHIR_SEARCH_PARAMS = ["_count", "_offset"] as const;

/**
 * Further search parameters the Observation search honours (v1.44). `date`
 * switches the answer from the snapshot to the time series of every reading
 * in the range; `code` narrows either answer to the named codings.
 */
export const FHIR_OBSERVATION_SEARCH_PARAMS = [
  { name: "date", type: "date" },
  { name: "code", type: "token" },
] as const;

/** Canonical FHIR media type for every response (success or outcome). */
export const FHIR_CONTENT_TYPE = "application/fhir+json; charset=utf-8";

/** Default page size; clamped to `[1, MAX_COUNT]`. */
export const DEFAULT_COUNT = 50;
/** Hard ceiling on `_count` so a single search can never page the whole store. */
export const MAX_COUNT = 200;

/**
 * Ceiling on `_offset`: the largest integer a JavaScript number holds
 * exactly. It is no paging limit (the Observation time series of a heart-rate
 * history pages well past a hundred thousand rows, and every page's `next`
 * link must keep working); it refuses only an offset that cannot be passed
 * on faithfully. Above it `Math.floor` returns a float such as `1e20`, which
 * the database cannot read as a `bigint` `OFFSET` and which answered 500.
 */
export const MAX_OFFSET = Number.MAX_SAFE_INTEGER;

/**
 * Parsed + clamped paging parameters. `count` is bounded to `[1, MAX_COUNT]`;
 * `offset` floors at 0. A non-numeric / negative input collapses to the
 * default rather than erroring — FHIR search is forgiving on paging params.
 * An offset above {@link MAX_OFFSET} (including `Infinity`) is the one
 * refusal: the caller answers it with a 400 `invalid` OperationOutcome.
 */
export function parsePaging(
  searchParams: URLSearchParams,
): { count: number; offset: number } | { error: string } {
  const rawCount = Number(searchParams.get("_count"));
  const count =
    Number.isFinite(rawCount) && rawCount > 0
      ? Math.min(Math.floor(rawCount), MAX_COUNT)
      : DEFAULT_COUNT;
  const rawOffset = Number(searchParams.get("_offset"));
  if (rawOffset > MAX_OFFSET) {
    return { error: `_offset must be at most ${MAX_OFFSET}` };
  }
  const offset =
    Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { count, offset };
}

/**
 * Build the absolute self link, and a next link when more rows remain. The
 * URL is rebuilt from the request URL with the paging params normalised, so
 * the echoed link always carries the clamped `_count` and concrete `_offset`.
 * A next link never carries an offset {@link parsePaging} would refuse.
 */
function pagingLinks(
  requestUrl: URL,
  total: number,
  count: number,
  offset: number,
): FhirBundleLink[] {
  const self = new URL(requestUrl.toString());
  self.searchParams.set("_count", String(count));
  self.searchParams.set("_offset", String(offset));
  const links: FhirBundleLink[] = [{ relation: "self", url: self.toString() }];

  const nextOffset = offset + count;
  if (nextOffset < total && nextOffset <= MAX_OFFSET) {
    const next = new URL(requestUrl.toString());
    next.searchParams.set("_count", String(count));
    next.searchParams.set("_offset", String(nextOffset));
    links.push({ relation: "next", url: next.toString() });
  }
  return links;
}

/**
 * Wrap a page of resources in a `searchset` Bundle and return it as a FHIR
 * JSON response. `total` is the FULL unpaged match count; `page` is the
 * already-sliced window. Each entry is tagged `search.mode: "match"`.
 */
export function searchsetResponse(
  requestUrl: URL,
  page: FhirResource[],
  total: number,
  count: number,
  offset: number,
): NextResponse {
  const entry: FhirBundleEntry[] = page.map((resource) => ({
    fullUrl: `${requestUrl.origin}/api/fhir/${resource.resourceType}/${resource.id}`,
    resource,
  }));
  return searchsetResponseFromEntries(requestUrl, entry, total, count, offset);
}

/**
 * The same `searchset` wrapper for a page whose entry identities are already
 * decided. `$everything` uses it to hand back the document bundle's own
 * `urn:uuid` fullUrls: those resources are not all individually addressable
 * (only the routed types have a `/{type}/{id}`), and minting a REST URL for a
 * Composition or an Encounter would advertise an address that 404s.
 */
export function searchsetResponseFromEntries(
  requestUrl: URL,
  page: ReadonlyArray<Omit<FhirBundleEntry, "search">>,
  total: number,
  count: number,
  offset: number,
): NextResponse {
  const entry: FhirBundleEntry[] = page.map((e) => ({
    fullUrl: e.fullUrl,
    resource: e.resource,
    search: { mode: "match" },
  }));

  const bundle: FhirSearchsetBundle = {
    resourceType: "Bundle",
    type: "searchset",
    timestamp: new Date().toISOString(),
    total,
    link: pagingLinks(requestUrl, total, count, offset),
    entry,
  };

  return new NextResponse(JSON.stringify(bundle), {
    status: 200,
    headers: { "Content-Type": FHIR_CONTENT_TYPE, "Cache-Control": "no-store" },
  });
}

/**
 * Answer a `GET /{Type}/{id}` read: the resource itself when the caller's own
 * record holds that id, an R4 `not-found` OperationOutcome otherwise. There is
 * no cross-user lookup — `candidates` is already the caller's set, so an id
 * belonging to someone else is indistinguishable from one that never existed.
 */
export function readResponse(
  candidates: readonly FhirResource[],
  id: string,
): NextResponse {
  const match = candidates.find((resource) => resource.id === id);
  if (!match) {
    return operationOutcome(404, "not-found", "No such resource");
  }
  return fhirJsonResponse(match);
}

/** Return a raw FHIR resource (e.g. CapabilityStatement) as a FHIR response. */
export function fhirJsonResponse(body: unknown): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": FHIR_CONTENT_TYPE, "Cache-Control": "no-store" },
  });
}

/**
 * Build an `OperationOutcome` JSON response — the FHIR error envelope. Used
 * for 404 (no such resource) and any other FHIR-shaped error the routes
 * surface. (Auth 401/403 stay on the standard envelope via `requireAuth`.)
 */
export function operationOutcome(
  status: number,
  code: string,
  diagnostics: string,
  severity: FhirOperationOutcome["issue"][number]["severity"] = "error",
): NextResponse {
  const outcome: FhirOperationOutcome = {
    resourceType: "OperationOutcome",
    issue: [{ severity, code, diagnostics }],
  };
  return new NextResponse(JSON.stringify(outcome), {
    status,
    headers: { "Content-Type": FHIR_CONTENT_TYPE, "Cache-Control": "no-store" },
  });
}

/**
 * Resolve everything an emitter needs for a caller: the aggregated report data
 * over the default reporting window, the decrypted KVNR identity, the
 * BfArM-ATC flag (derived from the user's locale), and the structured records
 * (allergies + family history) that live outside the time-windowed
 * aggregation. Centralised so each resource route is a one-liner over the
 * shared emitters.
 *
 * The window matches the document export's default (`normaliseDateRange`
 * with no override). KVNR decryption is fail-soft: a key-rotation gap on a
 * single row omits the identifier rather than 500-ing the read.
 *
 * MODULE BACKSTOP. Every `/api/fhir/*` data route calls
 * `requireModuleEnabled(userId, "doctorReport")` itself, which is what
 * produces the clean 403 envelope. This assertion is the second layer: the
 * loader is the one door to the whole-record aggregate (including the
 * decrypted insurance number), so it refuses outright rather than trusting
 * that every present and future caller remembered the gate. It throws
 * instead of returning an envelope because reaching it means a caller is
 * missing its gate — a bug to surface, not a flow to serve.
 */
export async function loadFhirContext(userId: string): Promise<{
  data: DoctorReportData;
  identity: FhirPatientIdentity;
  germanAtc: boolean;
  records: FhirRecordInputs;
}> {
  if (!(await isModuleEnabled(userId, "doctorReport"))) {
    throw new Error(
      'loadFhirContext called with the "doctorReport" module disabled — ' +
        "the calling route is missing its requireModuleEnabled gate",
    );
  }

  // The REST face cannot ask a human, so it replays the owner's SAVED
  // selection — the same object reviewed in Settings, no more and no less. An
  // account that never saved one resolves to the empty selection and this face
  // serves nothing, which is the honest answer to "give me a record the owner
  // never scoped". It used to assemble everything at server defaults.
  const selection = await resolveSavedSelection(userId);

  const range = normaliseDateRange(undefined);
  const [data, userRow, allergyRows, familyHistoryRows] = await Promise.all([
    collectDoctorReportData(userId, range, selection),
    prisma.user.findUnique({
      where: { id: userId },
      select: { ...INSURANCE_IDENTITY_SELECT, locale: true },
    }),
    // The structured records are always-available reference data (not
    // time-windowed), so they ride alongside the report rather than through
    // the aggregator — the same split `/api/export/health-record` uses.
    // Owner-scoped, live rows only.
    selection.has("ALLERGIES")
      ? prisma.allergy.findMany({
          where: { userId, deletedAt: null },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
    selection.has("FAMILY_HISTORY")
      ? prisma.familyHistoryEntry.findMany({
          where: { userId, deletedAt: null },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
  ]);

  // Neither read out nor decrypted unless the insurance leaf was chosen.
  const insurance = readInsuranceIdentity(
    selection.has("INSURANCE") ? userRow : null,
  );

  const germanAtc = (GERMAN_ATC_DEFAULT_LOCALES as readonly string[]).includes(
    userRow?.locale ?? "",
  );

  return {
    data,
    identity: insurance,
    germanAtc,
    records: {
      allergies: allergyRows.map(toAllergyDTO),
      familyHistory: familyHistoryRows.map(toFamilyHistoryEntryDTO),
    },
  };
}

/**
 * The series face's scope: the same saved selection and module map the
 * snapshot replays, narrowed by an optional `code` filter, plus the owner's
 * glucose unit. Reads two small rows and the selection — never the
 * whole-record aggregate, so a series page costs what its page costs.
 *
 * Carries the same module backstop as {@link loadFhirContext}.
 */
export async function loadFhirSeriesScope(
  userId: string,
  codes: SeriesCodeFilter | null,
): Promise<{ scope: SeriesScope; glucoseUnit: GlucoseUnit }> {
  if (!(await isModuleEnabled(userId, "doctorReport"))) {
    throw new Error(
      'loadFhirSeriesScope called with the "doctorReport" module disabled — ' +
        "the calling route is missing its requireModuleEnabled gate",
    );
  }
  const [selection, moduleMap, glucoseUnit] = await Promise.all([
    resolveSavedSelection(userId),
    resolveModuleMap(userId),
    seriesGlucoseUnit(userId),
  ]);
  const gate = resolveReportGate(selection, moduleMap);
  return { scope: resolveSeriesScope(gate, codes), glucoseUnit };
}

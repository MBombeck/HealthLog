/**
 * Which of an account's markers a printed name belongs to (D1223).
 *
 * One lab writes "Alkaline Phosphatase", the next "Alk.P", and each spelling
 * used to become a marker of its own with half the history. Every path that
 * turns a name into a marker resolves it here, in one order:
 *
 *   1. `name`    the marker's own name, case and spacing aside;
 *   2. `alias`   a spelling the account attached to a marker (merged in,
 *                chosen at an import, or typed on the marker), folded;
 *   3. `catalog` a name the catalog knows for the same analyte as a marker of
 *                the account ("GPT" for a marker called "ALT"), when the
 *                reading's unit is that marker's or converts to it;
 *   4. nothing   the caller mints a marker, or the review offers suggestions.
 *
 * Steps 1 and 2 are the account's own decisions and win regardless of the
 * unit; a unit that does not fit is then refused by the write, exactly as it
 * is for a marker picked by hand. Step 3 is the app's guess, so it steps aside
 * for a unit it cannot reconcile and the reading keeps its own marker.
 *
 * The matching is pure over a {@link MarkerIndex} loaded once per request, so
 * the scan review, the commit and the document import cannot disagree about
 * the same name.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { foldForMatch } from "@/lib/i18n/fold-for-match";

import {
  catalogKeyForName,
  catalogNamesForKey,
  foldWithoutDots,
} from "./analyte-match";
import { convertLabValue } from "./unit-conversion/convert";
import { sameLabUnit } from "./unit-normalise";

export type BiomarkerMatchKind = "name" | "alias" | "catalog";
export type BiomarkerSuggestionKind = "catalog" | "similar";

/** Most suggestions a review row offers. */
export const BIOMARKER_SUGGESTION_LIMIT = 3;

export interface IndexedMarker {
  id: string;
  name: string;
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
  analyteKey: string | null;
  hidden: boolean;
  createdAt: Date;
}

export interface IndexedAlias {
  biomarkerId: string;
  name: string;
  nameFolded: string;
}

export interface MarkerIndex {
  markers: readonly IndexedMarker[];
  aliases: readonly IndexedAlias[];
}

export interface MarkerMatch {
  marker: IndexedMarker;
  matchKind: BiomarkerMatchKind;
}

export interface MarkerSuggestion {
  biomarkerId: string;
  name: string;
  unit: string;
  matchKind: BiomarkerSuggestionKind;
}

const MARKER_SELECT = {
  id: true,
  name: true,
  unit: true,
  lowerBound: true,
  upperBound: true,
  panel: true,
  analyteKey: true,
  hidden: true,
  createdAt: true,
} as const;

/** Every marker and alias of the account, for {@link resolveInIndex}. */
export async function loadMarkerIndex(
  client: Pick<PrismaClient, "biomarker" | "biomarkerAlias">,
  userId: string,
): Promise<MarkerIndex> {
  const [markers, aliases] = await Promise.all([
    client.biomarker.findMany({
      where: { userId },
      select: MARKER_SELECT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    client.biomarkerAlias.findMany({
      where: { userId },
      select: { biomarkerId: true, name: true, nameFolded: true },
    }),
  ]);
  return { markers, aliases };
}

/** Add a marker minted after the index was loaded, so later rows see it. */
export function addToIndex(index: MarkerIndex, marker: IndexedMarker): void {
  if (index.markers.some((m) => m.id === marker.id)) return;
  (index.markers as IndexedMarker[]).push(marker);
}

/** Record an alias written after the index was loaded. */
export function addAliasToIndex(
  index: MarkerIndex,
  biomarkerId: string,
  name: string,
): void {
  const nameFolded = foldForMatch(name.trim());
  const list = index.aliases as IndexedAlias[];
  const at = list.findIndex((a) => a.nameFolded === nameFolded);
  const entry = { biomarkerId, name: name.trim(), nameFolded };
  if (at >= 0) list[at] = entry;
  else list.push(entry);
}

/** Visible before hidden, then the oldest: the order a tie is broken in. */
function preferred(candidates: IndexedMarker[]): IndexedMarker | null {
  if (candidates.length === 0) return null;
  const visible = candidates.filter((m) => !m.hidden);
  return (visible.length > 0 ? visible : candidates)[0] ?? null;
}

/** The catalog analytes a marker answers to: through its name and its aliases. */
function markerCatalogKeys(
  index: MarkerIndex,
  marker: IndexedMarker,
): Set<string> {
  const keys = new Set<string>();
  const own = catalogKeyForName(marker.name) ?? marker.analyteKey;
  if (own) keys.add(own);
  for (const alias of index.aliases) {
    if (alias.biomarkerId !== marker.id) continue;
    const key = catalogKeyForName(alias.name);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Whether a reading stated in `unit` can be stored under the marker: the same
 * unit, or one the conversion moves into it. No unit (a qualitative reading,
 * or none stated) always fits.
 *
 * A marker with an empty unit takes any unit: no reading has chosen its unit
 * yet, so the first numeric reading that states one gives it that unit when it
 * is written (`adoptFirstNumericUnit` in `./reading-conversion.ts`), numbers
 * it already holds without a unit included.
 */
export function unitFitsMarker(
  marker: Pick<IndexedMarker, "unit" | "analyteKey">,
  unit: string | null | undefined,
  analyteKey: string | null,
): boolean {
  if (unit === null || unit === undefined || unit.trim() === "") return true;
  if (marker.unit.trim() === "") return true;
  if (sameLabUnit(unit, marker.unit)) return true;
  return convertLabValue({
    analyteKey: marker.analyteKey ?? analyteKey,
    value: 1,
    from: unit,
    to: marker.unit,
  }).ok;
}

/**
 * The marker a printed name resolves to, and how; null when nothing does.
 * `unit` is the unit the reading states, used only by the catalog step.
 * `options.catalogKey` names the catalog analyte when the source says which
 * one it is (a LOINC code on a FHIR result): the catalog step then uses it in
 * place of the analyte the name alone would suggest. The account's own names
 * and aliases still win first.
 */
export function resolveInIndex(
  index: MarkerIndex,
  rawName: string,
  unit?: string | null,
  options: { catalogKey?: string | null } = {},
): MarkerMatch | null {
  const name = rawName.trim();
  if (!name) return null;

  // 1. The marker's own name. An exact spelling wins over one that differs in
  //    case, which wins over one that differs only in punctuation and spacing,
  //    and that last one only when it names a single marker.
  const exact = index.markers.find((m) => m.name === name);
  if (exact) return { marker: exact, matchKind: "name" };
  const lower = name.toLowerCase();
  const caseless = preferred(
    index.markers.filter((m) => m.name.trim().toLowerCase() === lower),
  );
  if (caseless) return { marker: caseless, matchKind: "name" };
  const folded = foldForMatch(name);
  const byFold = index.markers.filter((m) => foldForMatch(m.name) === folded);
  if (byFold.length === 1) return { marker: byFold[0], matchKind: "name" };

  // 2. An alias of the account.
  const alias = index.aliases.find((a) => a.nameFolded === folded);
  if (alias) {
    const marker = index.markers.find((m) => m.id === alias.biomarkerId);
    if (marker) return { marker, matchKind: "alias" };
  }

  // 3. The catalog: a marker of the same analyte that can take the unit.
  const key = options.catalogKey ?? catalogKeyForName(name);
  if (key) {
    const candidates = index.markers.filter(
      (m) =>
        markerCatalogKeys(index, m).has(key) && unitFitsMarker(m, unit, key),
    );
    const marker = preferred(candidates);
    if (marker) return { marker, matchKind: "catalog" };
  }

  return null;
}

/** Folded name without dots, commas or parentheses, for the similarity. */
function loose(raw: string): string {
  return foldWithoutDots(raw)
    .replace(/[()[\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function bigrams(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length - 1; i++) out.push(text.slice(i, i + 2));
  return out;
}

/** Sørensen-Dice over character bigrams, 0..1. */
export function diceSimilarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.length === 0 || y.length === 0) return a === b && a !== "" ? 1 : 0;
  const counts = new Map<string, number>();
  for (const g of y) counts.set(g, (counts.get(g) ?? 0) + 1);
  let shared = 0;
  for (const g of x) {
    const n = counts.get(g) ?? 0;
    if (n > 0) {
      shared += 1;
      counts.set(g, n - 1);
    }
  }
  return (2 * shared) / (x.length + y.length);
}

/**
 * Shorthand against the full name: every word of the shorter is the start of
 * a word of the longer, in order ("alk phos" against "alkaline phosphatase").
 */
function abbreviates(short: string, long: string): boolean {
  const s = short.split(" ").filter(Boolean);
  const l = long.split(" ").filter(Boolean);
  if (s.length === 0 || s.length > l.length) return false;
  let j = 0;
  for (const word of s) {
    while (j < l.length && !l[j].startsWith(word)) j++;
    if (j === l.length) return false;
    j++;
  }
  return true;
}

/** How alike two names are, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const x = loose(a);
  const y = loose(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  const prefix = abbreviates(shorter, longer) ? 0.8 : 0;
  return Math.max(prefix, diceSimilarity(x, y));
}

/** Below this a marker is not offered as similar. */
export const SIMILARITY_FLOOR = 0.5;

/**
 * Up to three markers a review row offers for a name nothing resolved:
 * first the markers of the same catalog analyte (their unit kept the catalog
 * step from taking them), then the markers whose name, aliases or catalog
 * names are most alike. Hidden markers are not offered.
 */
export function suggestInIndex(
  index: MarkerIndex,
  rawName: string,
  limit = BIOMARKER_SUGGESTION_LIMIT,
): MarkerSuggestion[] {
  const name = rawName.trim();
  if (!name) return [];
  const out: MarkerSuggestion[] = [];
  const taken = new Set<string>();
  const visible = index.markers.filter((m) => !m.hidden);

  const key = catalogKeyForName(name);
  if (key) {
    for (const marker of visible) {
      if (out.length >= limit) break;
      if (!markerCatalogKeys(index, marker).has(key)) continue;
      out.push(toSuggestion(marker, "catalog"));
      taken.add(marker.id);
    }
  }

  const scored: Array<{ marker: IndexedMarker; score: number }> = [];
  for (const marker of visible) {
    if (taken.has(marker.id)) continue;
    const names = [marker.name];
    for (const alias of index.aliases) {
      if (alias.biomarkerId === marker.id) names.push(alias.name);
    }
    for (const k of markerCatalogKeys(index, marker)) {
      names.push(...catalogNamesForKey(k));
    }
    let score = 0;
    for (const candidate of names) {
      score = Math.max(score, nameSimilarity(name, candidate));
    }
    if (score >= SIMILARITY_FLOOR) scored.push({ marker, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || a.marker.name.localeCompare(b.marker.name),
  );
  for (const { marker } of scored) {
    if (out.length >= limit) break;
    out.push(toSuggestion(marker, "similar"));
  }
  return out;
}

function toSuggestion(
  marker: IndexedMarker,
  matchKind: BiomarkerSuggestionKind,
): MarkerSuggestion {
  return {
    biomarkerId: marker.id,
    name: marker.name,
    unit: marker.unit,
    matchKind,
  };
}

/**
 * Resolution and suggestions for one name, as the review rows carry them:
 * the matched marker and how, or none and up to three to choose from.
 */
export function matchForReview(
  index: MarkerIndex,
  name: string,
  unit?: string | null,
): {
  match: MarkerMatch | null;
  suggestions: MarkerSuggestion[];
} {
  const match = resolveInIndex(index, name, unit);
  return {
    match,
    suggestions: match ? [] : suggestInIndex(index, name),
  };
}

/**
 * The marker a name asked for on a read path (MCP `get_labs`, the
 * `healthlog://lab/{analyte}` resource) resolves to: its name, an alias or a
 * catalog abbreviation, with no unit to weigh. Null when nothing resolves;
 * the caller then keeps its own text match.
 */
export async function resolveMarkerForRead(
  userId: string,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const index = await loadMarkerIndex(prisma, userId);
  const match = resolveInIndex(index, name);
  return match ? { id: match.marker.id, name: match.marker.name } : null;
}

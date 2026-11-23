import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { formatMessage } from "@/lib/i18n/format-message";

/**
 * The description slot holds ONE sentence, guideline ≤ 120 characters
 * (design standards §3).
 *
 * Scope is deliberately the strings that actually reach a card header's
 * description slot, whether the prop sits on the header or on a shell that
 * forwards it. That is the slot the rule is about. A hint in a card BODY is
 * prose and is allowed to be prose; `scripts/measure-description-lengths.mjs`
 * sweeps those for review without gating them.
 *
 * Both EN and DE are checked. DE runs 15-25% longer than EN, and a rule that
 * only holds in English produces a slot that wraps to two lines in half the
 * locales — which is the same defect, moved.
 */

const ROOT = process.cwd();
const MAX_CHARS = 120;

/**
 * Strings that stay longer than the guideline, each with the reason. The
 * guideline is not a hard cut: a sentence that needs 130 characters to stay
 * true is fine. Two sentences never are, and that half of the rule has no
 * exceptions.
 */
const LENGTH_EXCEPTIONS: Record<string, string> = {
  // Empty on purpose: the sweep that introduced this guard left nothing over
  // the guideline in EN or DE. An entry here needs a sentence saying what the
  // extra characters buy, and `carries no stale exception` deletes it again
  // the moment the string fits or stops being a description.
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(full, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Elements whose `description` prop reaches `SettingsCardHeader`'s slot.
 *
 * The first cut of this guard matched `<SettingsCardHeader` only, and only
 * under three component folders. That left five real card descriptions
 * invisible to it — one of them the 351-character, three-sentence full-backup
 * text that the audit's own shortlist had named. Two ways in were missing:
 * a card header rendered from a folder the walk never entered, and a
 * description FORWARDED to the header by a shell (`ExportCardShell`,
 * `ImportCardShell`), where the prop is on the shell's tag rather than the
 * header's.
 *
 * `SubPageShell` is deliberately NOT here. Its description renders as
 * `<p className="text-foreground text-sm">` — the body tier, where the
 * standards allow prose. Gating it would enforce a rule §3 does not make for
 * that tier.
 */
const DESCRIPTION_HOSTS = [
  "SettingsCardHeader",
  "ExportCardShell",
  "ImportCardShell",
];

/** Component roots that can host a card header, directly or via a shell. */
const ROOTS = [
  join("src", "components", "settings"),
  join("src", "components", "admin"),
  join("src", "components", "measurement-reminders"),
  join("src", "components", "labs"),
  join("src", "components", "insights"),
  join("src", "components", "medications"),
  join("src", "components", "records"),
];

/** Every `description={t("…")}` on an element that owns the header's slot. */
function describedKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (const root of ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      const source = readFileSync(file, "utf8");
      const host = new RegExp(`<(?:${DESCRIPTION_HOSTS.join("|")})\\b`, "g");
      let match: RegExpExecArray | null;
      while ((match = host.exec(source))) {
        // The element ends at the first `/>` or `>` that closes the opening
        // tag; a `description={t("x")}` after that belongs to something else.
        const selfClose = source.indexOf("/>", match.index);
        const childrenOpen = source.indexOf("\n    >", match.index);
        const end = [selfClose, childrenOpen]
          .filter((i) => i !== -1)
          .sort((a, b) => a - b)[0];
        const slice = source.slice(match.index, end ?? undefined);
        const desc = /description=\{t\(\s*"([^"]+)"/.exec(slice);
        if (!desc) continue;
        const list = keys.get(desc[1]) ?? [];
        list.push(file.slice(ROOT.length + 1));
        keys.set(desc[1], list);
      }
    }
  }
  return keys;
}

function resolve(bundle: unknown, key: string): string | undefined {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      bundle,
    );
  if (typeof value !== "string") return undefined;
  // A plural block counts as the sentence a reader sees: render it with a
  // typical number so its option syntax does not count toward the length.
  const counts: Record<string, number> = {};
  for (const m of value.matchAll(/\{(\w+)\s*,\s*plural\s*,/g)) {
    counts[m[1]!] = 30;
  }
  return Object.keys(counts).length
    ? formatMessage(value, counts, "en")
    : value;
}

/** Sentence terminators followed by a space or the end of the string. */
function sentenceCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const matches = trimmed.match(/[.!?](\s+\S|$)/g);
  return Math.max(1, matches ? matches.length : 1);
}

describe("card header descriptions — one sentence, ≤120 characters", () => {
  const keys = describedKeys();

  it("finds the description slots it is meant to check", () => {
    // A matcher that quietly matches nothing passes every assertion below it.
    expect(keys.size).toBeGreaterThan(35);
  });

  for (const locale of ["en", "de"] as const) {
    const bundle = JSON.parse(
      readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8"),
    );

    it(`${locale}: every description is a single sentence`, () => {
      const offenders: string[] = [];
      for (const [key, files] of keys) {
        const value = resolve(bundle, key);
        if (value === undefined) continue; // the i18n coverage guard owns this
        if (sentenceCount(value) > 1) {
          offenders.push(
            `${key} (${sentenceCount(value)} sentences) — ${files[0]}`,
          );
        }
      }
      expect(offenders).toEqual([]);
    });

    it(`${locale}: every description is within the length guideline`, () => {
      const offenders: string[] = [];
      for (const [key, files] of keys) {
        const value = resolve(bundle, key);
        if (value === undefined) continue;
        if (value.length > MAX_CHARS && !(key in LENGTH_EXCEPTIONS)) {
          offenders.push(`${key} (${value.length} chars) — ${files[0]}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it("carries no stale exception", () => {
    const bundle = JSON.parse(
      readFileSync(join(ROOT, "messages", "en.json"), "utf8"),
    );
    for (const [key, reason] of Object.entries(LENGTH_EXCEPTIONS)) {
      expect(
        keys.has(key),
        `${key} is allowlisted but no longer a description`,
      ).toBe(true);
      expect(
        resolve(bundle, key)!.length,
        `${key} is allowlisted but now fits the guideline`,
      ).toBeGreaterThan(MAX_CHARS);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

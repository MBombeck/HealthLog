/**
 * The source scan the dense-measurement read guards share: which files they
 * walk, how a call's brackets and `where` are read, and which measurement
 * types a device writes at sampling rate.
 */
import { join } from "node:path";

import { walkSourceFiles } from "./source-files";
import {
  CUMULATIVE_HK_TYPES,
  HIGH_FREQUENCY_MEAN_TYPES,
} from "@/lib/measurements/apple-health-mapping";

export const SRC = join(process.cwd(), "src");

/** Types a device writes at sampling rate rather than a few times a day. */
export const DENSE_TYPES: ReadonlySet<string> = new Set([
  "PULSE",
  "BLOOD_GLUCOSE",
  "HEART_RATE_VARIABILITY",
  "OXYGEN_SATURATION",
  ...CUMULATIVE_HK_TYPES,
  ...HIGH_FREQUENCY_MEAN_TYPES,
]);

export function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

/** Index just past the bracket that closes the one at `open`. */
export function closeOf(src: string, open: number): number {
  const pair: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const want = pair[src[open]];
  let depth = 1;
  let i = open + 1;
  while (depth > 0 && i < src.length) {
    if (src[i] === src[open]) depth += 1;
    else if (src[i] === want) depth -= 1;
    i += 1;
  }
  return i;
}

/** The `where: { … }` object of a call, or null when `where` is a variable. */
export function whereObject(call: string): string | null {
  const m = /\bwhere\s*:\s*\{/.exec(call);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  return call.slice(open, closeOf(call, open));
}

/** The type expression a `where` object constrains on. */
export function typeExprOf(call: string): string {
  const where = whereObject(call);
  if (where === null) {
    return /\bwhere\s*[,}]/.test(call) ? "(where variable)" : "(none)";
  }
  const typed = /\btype\s*:\s*([^,\n}]+)/.exec(where);
  if (typed) return typed[1].trim();
  return /\btype\s*[,}\n]/.test(where) ? "(shorthand)" : "(none)";
}

export function sparseLiteral(typeExpr: string): boolean {
  const lit = /^"([A-Z_0-9]+)"/.exec(typeExpr);
  if (lit) return !DENSE_TYPES.has(lit[1]);
  const list = /^\{\s*in\s*:\s*\[([^\]]*)/.exec(typeExpr);
  if (!list) return false;
  const items = list[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    items.length > 0 &&
    items.every((item) => {
      const m = /^"([A-Z_0-9]+)"$/.exec(item);
      return m !== null && !DENSE_TYPES.has(m[1]);
    })
  );
}

export function measurementReadSourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

#!/usr/bin/env node
/**
 * Reads `.next/analyze/client.json` (emitted when `pnpm analyze` runs
 * `@next/bundle-analyzer` with `ANALYZE=1`) and prints a sorted table
 * of the largest client chunks. Turbopack dropped the webpack
 * "First Load JS" summary line from `next build`; this script restores
 * an equivalent at-a-glance signal so release rounds can spot
 * client-bundle regressions without re-running Lighthouse.
 *
 * Usage:
 *   pnpm analyze            # writes .next/analyze/client.json
 *   pnpm bundle-report      # reads it back, prints top chunks
 *
 * Output columns: rank, chunk label, parsed (post-minify) size, gzip
 * size, stat (pre-minify) size. Sizes report in KiB to two decimals.
 * Exits 0 unless `client.json` is missing or unreadable.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPORT_PATH = resolve(process.cwd(), ".next", "analyze", "client.json");
const DEFAULT_TOP_N = 10;

function formatKib(bytes) {
  if (typeof bytes !== "number" || Number.isNaN(bytes)) return "—";
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function padCell(value, width) {
  const str = String(value ?? "");
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

async function main() {
  const argTopN = Number(process.argv[2]);
  const topN =
    Number.isFinite(argTopN) && argTopN > 0
      ? Math.floor(argTopN)
      : DEFAULT_TOP_N;

  let raw;
  try {
    raw = await readFile(REPORT_PATH, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      console.error(
        `bundle-report: ${REPORT_PATH} not found. Run \`pnpm analyze\` first.`,
      );
    } else {
      console.error(`bundle-report: failed to read ${REPORT_PATH}:`, err);
    }
    process.exit(1);
  }

  let chunks;
  try {
    chunks = JSON.parse(raw);
  } catch (err) {
    console.error(`bundle-report: failed to parse ${REPORT_PATH}:`, err);
    process.exit(1);
  }

  if (!Array.isArray(chunks)) {
    console.error(
      "bundle-report: client.json is not an array of chunks — analyzer output shape changed?",
    );
    process.exit(1);
  }

  const sorted = [...chunks].sort(
    (a, b) => (b.parsedSize ?? 0) - (a.parsedSize ?? 0),
  );
  const top = sorted.slice(0, topN);

  const totals = chunks.reduce(
    (acc, c) => ({
      parsed: acc.parsed + (c.parsedSize ?? 0),
      gzip: acc.gzip + (c.gzipSize ?? 0),
      stat: acc.stat + (c.statSize ?? 0),
    }),
    { parsed: 0, gzip: 0, stat: 0 },
  );

  const labelWidth = Math.max(
    20,
    ...top.map((c) => String(c.label ?? "").length),
  );
  const header =
    `${padCell("#", 3)}  ${padCell("chunk", labelWidth)}  ` +
    `${padCell("parsed", 12)}  ${padCell("gzip", 12)}  ${padCell("stat", 12)}`;

  console.log(
    `Top ${top.length} client chunks by parsed size (of ${chunks.length} total):`,
  );
  console.log(header);
  console.log("-".repeat(header.length));
  top.forEach((chunk, idx) => {
    console.log(
      `${padCell(idx + 1, 3)}  ${padCell(chunk.label ?? "(unnamed)", labelWidth)}  ` +
        `${padCell(formatKib(chunk.parsedSize), 12)}  ` +
        `${padCell(formatKib(chunk.gzipSize), 12)}  ` +
        `${padCell(formatKib(chunk.statSize), 12)}`,
    );
  });
  console.log("-".repeat(header.length));
  console.log(
    `${padCell("Σ", 3)}  ${padCell("all chunks", labelWidth)}  ` +
      `${padCell(formatKib(totals.parsed), 12)}  ` +
      `${padCell(formatKib(totals.gzip), 12)}  ` +
      `${padCell(formatKib(totals.stat), 12)}`,
  );
}

main().catch((err) => {
  console.error("bundle-report: unexpected failure:", err);
  process.exit(1);
});

#!/usr/bin/env node
// One-shot dead-key auditor for v1.4.27 B6.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const MESSAGES = join(ROOT, "messages");
const SRC = join(ROOT, "src");

const en = JSON.parse(readFileSync(join(MESSAGES, "en.json"), "utf8"));

function flatten(obj, prefix, out) {
  if (obj == null || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push(key);
    else if (typeof v === "object") flatten(v, key, out);
  }
}

const allKeys = [];
flatten(en, "", allKeys);
console.error(`Loaded ${allKeys.length} keys from en.json`);

function collect(dir, acc) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next" || name === "dist") continue;
      collect(p, acc);
      continue;
    }
    const ext = extname(name);
    if (
      ext === ".ts" ||
      ext === ".tsx" ||
      ext === ".js" ||
      ext === ".jsx" ||
      ext === ".mjs"
    ) {
      acc.push(p);
    }
  }
}

const files = [];
collect(SRC, files);
const testFiles = [];
try { collect(join(ROOT, "scripts"), testFiles); } catch {}

console.error(`Scanning ${files.length + testFiles.length} src+script files...`);

const corpus = [...files, ...testFiles]
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

// Extract backtick literal contents. Naively walk the string to capture
// backtick-delimited bodies. Skip empties.
const backtickBodies = [];
{
  let i = 0;
  while (i < corpus.length) {
    if (corpus[i] === "`") {
      i++;
      let depth = 0;
      let start = i;
      while (i < corpus.length) {
        const c = corpus[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "$" && corpus[i + 1] === "{") { depth++; i += 2; continue; }
        if (c === "}" && depth > 0) { depth--; i++; continue; }
        if (c === "`" && depth === 0) break;
        i++;
      }
      backtickBodies.push(corpus.slice(start, i));
      if (corpus[i] === "`") i++;
      continue;
    }
    i++;
  }
}

// For each backtick body that LOOKS LIKE an i18n key (has dots and starts
// with a known top-level namespace), build a regex by replacing ${...}
// with `[^\s\\`]*` and matching against every dotted key.
const TOPLEVELS = new Set(Object.keys(en));
const templatePatterns = [];
for (const body of backtickBodies) {
  if (!body.includes("${")) continue;
  // The body must start with an i18n top-level namespace + dot.
  const firstWordMatch = body.match(/^([a-zA-Z][a-zA-Z0-9_]*)/);
  if (!firstWordMatch) continue;
  const ns = firstWordMatch[1];
  if (!TOPLEVELS.has(ns)) continue;
  if (!body.includes(".")) continue;
  // Build regex.
  const escaped = body
    .replace(/[.+?^()|[\]\\]/g, (c) => "\\" + c)
    .replace(/\$\{[^}]+\}/g, "[a-zA-Z0-9_\\-]+");
  try {
    templatePatterns.push(new RegExp("^" + escaped + "$"));
  } catch {}
}

console.error(`Found ${templatePatterns.length} templated key patterns.`);

const deadKeys = [];
const liveKeys = [];

for (const key of allKeys) {
  // 1) Direct quoted hit.
  if (
    corpus.includes(`"${key}"`) ||
    corpus.includes(`'${key}'`) ||
    corpus.includes(`\`${key}\``)
  ) {
    liveKeys.push(key);
    continue;
  }

  // 2) Template pattern match.
  let hit = false;
  for (const re of templatePatterns) {
    if (re.test(key)) { hit = true; break; }
  }
  if (hit) {
    liveKeys.push(key);
    continue;
  }

  deadKeys.push(key);
}

console.error(`Live keys: ${liveKeys.length}`);
console.error(`Dead key candidates: ${deadKeys.length}`);

for (const k of deadKeys.sort()) console.log(k);

#!/usr/bin/env node
// v1.4.27 B6 — commit 1.
// Strips the 152 dead keys (one-shot probe output) from every locale
// bundle, plus the directive-listed extras:
//   - dashboard.insightsPreview
//   - insights.aiInsights
//   - insights.healthScore.askCoach
//   - insights.healthScore.coachPrompt
// The first two are already in the probe output. The two healthScore.*
// keys live under a parent that's still live, so we drop them explicitly.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const MESSAGES = join(ROOT, "messages");

const DEAD_LIST = readFileSync("/tmp/dead-keys.txt", "utf8")
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

const EXTRA_DROP = [
  "insights.healthScore.askCoach",
  "insights.healthScore.coachPrompt",
];

const allDead = new Set([...DEAD_LIST, ...EXTRA_DROP]);

function removeKey(obj, dotted) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return false;
    cur = cur[parts[i]];
  }
  if (cur == null || typeof cur !== "object") return false;
  const last = parts[parts.length - 1];
  if (!(last in cur)) return false;
  delete cur[last];
  return true;
}

function pruneEmptyContainers(obj) {
  if (obj == null || typeof obj !== "object") return false;
  let pruned = false;
  for (const k of Object.keys(obj)) {
    if (obj[k] != null && typeof obj[k] === "object" && !Array.isArray(obj[k])) {
      pruneEmptyContainers(obj[k]);
      if (Object.keys(obj[k]).length === 0) {
        delete obj[k];
        pruned = true;
      }
    }
  }
  return pruned;
}

const files = readdirSync(MESSAGES).filter((f) => f.endsWith(".json"));
let totalRemovals = 0;
const perLocale = {};
for (const f of files) {
  const path = join(MESSAGES, f);
  const data = JSON.parse(readFileSync(path, "utf8"));
  let removed = 0;
  for (const key of allDead) {
    if (removeKey(data, key)) removed++;
  }
  // Prune empty parent objects (repeat until stable).
  while (pruneEmptyContainers(data)) {
    // intentionally empty — outer loop runs the pruner.
  }
  perLocale[f] = removed;
  totalRemovals += removed;
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

console.log(`Total dead keys removed (sum across locales): ${totalRemovals}`);
for (const [f, n] of Object.entries(perLocale)) {
  console.log(`  ${f}: ${n}`);
}
console.log(`Unique dead-key paths: ${allDead.size}`);

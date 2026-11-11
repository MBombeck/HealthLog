/**
 * One-shot helper for a text sweep across every locale bundle.
 *
 *   node scripts/i18n-key-tool.mjs drop  <dotted.key> [...]
 *   node scripts/i18n-key-tool.mjs set   <locale> <dotted.key> <value>
 *   node scripts/i18n-key-tool.mjs show  <dotted.key>
 *
 * Keys are dotted paths into the bundle; a segment containing a literal dot
 * is not supported (no such key exists). `drop` removes the key from every
 * locale and prunes an object left empty behind it.
 */
import { readFileSync, writeFileSync } from "node:fs";

const LOCALES = ["de", "en", "es", "fr", "it", "pl", "ko", "nl", "pt-BR", "ru"];
const file = (loc) => `messages/${loc}.json`;

function read(loc) {
  return JSON.parse(readFileSync(file(loc), "utf8"));
}
function write(loc, data) {
  writeFileSync(file(loc), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function drop(bundle, path) {
  const parts = path.split(".");
  const last = parts.pop();
  const chain = [];
  let node = bundle;
  for (const part of parts) {
    if (node == null || typeof node !== "object") return false;
    chain.push([node, part]);
    node = node[part];
  }
  if (node == null || !(last in node)) return false;
  delete node[last];
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const [parent, key] = chain[i];
    if (parent[key] && Object.keys(parent[key]).length === 0)
      delete parent[key];
    else break;
  }
  return true;
}

function set(bundle, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  let node = bundle;
  for (const part of parts) {
    if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
    node = node[part];
  }
  node[last] = value;
}

function get(bundle, path) {
  return path.split(".").reduce((n, p) => (n == null ? n : n[p]), bundle);
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "drop") {
  for (const loc of LOCALES) {
    const bundle = read(loc);
    let n = 0;
    for (const key of rest) if (drop(bundle, key)) n += 1;
    write(loc, bundle);
    console.log(`${loc}: dropped ${n}/${rest.length}`);
  }
} else if (cmd === "set") {
  const [loc, key, ...valueParts] = rest;
  const bundle = read(loc);
  set(bundle, key, valueParts.join(" "));
  write(loc, bundle);
  console.log(`${loc}: ${key} set`);
} else if (cmd === "show") {
  for (const loc of LOCALES) {
    console.log(`${loc}\t${JSON.stringify(get(read(loc), rest[0]))}`);
  }
} else {
  console.error("usage: drop|set|show");
  process.exit(1);
}

#!/usr/bin/env node
/**
 * The third-party software HealthLog ships, and the licence policy it holds.
 *
 * What ships is not the whole dependency tree. A release image carries:
 *   - the production closure of `package.json` (Next bundles most of it into
 *     `.next`, where no SBOM scanner sees it, and traces the rest into
 *     `/app/node_modules`);
 *   - the build-only packages whose files end up in the output
 *     (`SHIPPED_BUILD_PACKAGES`: the OCR language data, the CSS that
 *     Tailwind and tw-animate-css emit, the PDF renderer the server loads);
 *   - the migration CLI under `/opt/prisma-cli`, installed by npm from
 *     `docker/prisma-cli/package-lock.json`;
 *   - components that come from no package manager at all, listed by hand
 *     in `THIRD_PARTY_NOTICES.md` (Node, the PostgreSQL client, Debian
 *     packages, the Inter font, GeoLite2 data).
 *
 * Modes:
 *   --check            (default) Read the tree from the lockfiles and the
 *                      installed packages, apply the policy, and compare the
 *                      licences in use with the list in THIRD_PARTY_NOTICES.md.
 *                      Fails on a licence the policy refuses, on a package
 *                      without a readable licence, and on a licence that is
 *                      allowed but not yet listed: a new licence is a
 *                      decision, recorded by running --write and reviewing
 *                      the diff.
 *   --write            Rewrite the generated sections of THIRD_PARTY_NOTICES.md.
 *   --bundle-pnpm OUT --traced DIR
 *                      Write every shipped pnpm package with its licence
 *                      files to OUT. Runs in the image's builder stage, after
 *                      `next build`. DIR is the pnpm store of the standalone
 *                      output (`.next/standalone/node_modules/.pnpm`): every
 *                      package the tracer copied there ships, whatever the
 *                      lockfile says, and is listed and held to the policy.
 *   --bundle-npm DIR --out OUT
 *                      The same for the npm tree installed in DIR (the
 *                      migration CLI stage). Needs nothing but Node.
 *   --sbom FILE --inventory OUT [--inventory OUT2 ...]
 *                      Every npm package the image's SBOM reports must be in
 *                      one of the bundles. Runs against a published image.
 *
 * The policy follows from the project licence. HealthLog is distributed
 * under the PolyForm Noncommercial License 1.0.0, which adds a use
 * restriction no GPL-family licence allows on a combined work. So:
 *   - permissive licences are allowed (ALLOWED);
 *   - file-level copyleft (MPL-2.0, EPL-2.0) is allowed for packages shipped
 *     unmodified, whose source stays where the package came from;
 *   - the LGPL is allowed only for the named native libraries that are
 *     loaded dynamically and shipped unmodified, so a user can replace them
 *     (LGPL_EXCEPTIONS);
 *   - GPL, AGPL, SSPL, the BUSL, non-commercial and share-alike licences,
 *     "UNLICENSED" and anything unreadable are refused.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOTICES = join(ROOT, "THIRD_PARTY_NOTICES.md");
const OWN_PACKAGES = new Set(["healthlog", "healthlog-prisma-cli"]);

const ALLOWED = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);
const FILE_COPYLEFT = new Set(["EPL-2.0", "MPL-2.0"]);
/** Package-name prefix -> the LGPL licence it may carry. */
const LGPL_EXCEPTIONS = new Map([["@img/sharp-libvips-", "LGPL-3.0-or-later"]]);
/** Build-time packages whose files are part of the shipped output. */
const SHIPPED_BUILD_PACKAGES = [
  "@tesseract.js-data/deu",
  "@tesseract.js-data/eng",
  "pdfjs-dist",
  "tailwindcss",
  "tw-animate-css",
];

const ALIASES = new Map([
  ["Apache 2.0", "Apache-2.0"],
  ["Apache License 2.0", "Apache-2.0"],
  ["BSD", "BSD-2-Clause"],
  ["MIT/X11", "MIT"],
]);

/** One SPDX-ish licence field as a normalised expression string. */
export function licenceOf(pkg) {
  let raw = pkg.license ?? pkg.licence;
  if (raw && typeof raw === "object") raw = raw.type;
  if (!raw && Array.isArray(pkg.licenses)) {
    const types = pkg.licenses
      .map((l) => (typeof l === "string" ? l : l?.type))
      .filter(Boolean);
    raw = types.length > 1 ? `(${types.join(" OR ")})` : types[0];
  }
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const text = raw
    .trim()
    .replace(/\s+and\s+/gi, " AND ")
    .replace(/\s+or\s+/gi, " OR ");
  return ALIASES.get(text) ?? text;
}

/** The single identifiers an expression names. */
function identifiers(expression) {
  return expression
    .replace(/[()]/g, " ")
    .split(/\s+(?:AND|OR|WITH)\s+|\s+/)
    .filter((t) => t && t !== "AND" && t !== "OR" && t !== "WITH");
}

/**
 * Whether a licence expression may ship for this package: an `OR` is
 * satisfied by any allowed alternative, an `AND` needs every part.
 */
export function verdict(name, expression) {
  if (!expression) return { ok: false, why: "no licence declared" };
  const permitted = (id) => {
    if (ALLOWED.has(id) || FILE_COPYLEFT.has(id)) return true;
    for (const [prefix, licence] of LGPL_EXCEPTIONS) {
      if (name.startsWith(prefix) && id === licence) return true;
    }
    return false;
  };
  const alternatives = expression
    .replace(/^\((.*)\)$/, "$1")
    .split(/\s+OR\s+/)
    .map((alt) => identifiers(alt));
  const ok = alternatives.some((ids) => ids.length > 0 && ids.every(permitted));
  return ok ? { ok: true } : { ok: false, why: `licence ${expression}` };
}

// ── The pnpm tree ─────────────────────────────────────────────────────────

/** `name@version` with the peer suffix removed. */
function bareKey(key) {
  const paren = key.indexOf("(");
  return paren === -1 ? key : key.slice(0, paren);
}

function snapshotKey(name, version) {
  if (version.startsWith("link:") || version.startsWith("file:")) return null;
  // An alias (`string-width-cjs: string-width@4.2.3`) names the real package.
  return /^[0-9]/.test(version) ? `${name}@${version}` : version;
}

function splitKey(key) {
  const at = key.lastIndexOf("@");
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/**
 * The shipped pnpm packages: the production closure of the root importer
 * plus `SHIPPED_BUILD_PACKAGES`, and for each `name@version` the packages
 * that depend on it. A platform build for another OS or CPU is not installed
 * here; its licence is read from the nearest installed package above it.
 */
export function pnpmShipped(lock) {
  const root = lock.importers["."];
  const parents = new Map();
  const seen = new Set();
  const queue = [];
  const enqueue = (name, version, parent) => {
    const key = snapshotKey(name, version);
    if (!key) return;
    const bare = bareKey(key);
    if (parent) {
      if (!parents.has(bare)) parents.set(bare, []);
      parents.get(bare).push(parent);
    }
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(key);
  };
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(root[field] ?? {})) {
      enqueue(name, spec.version, null);
    }
  }
  for (const name of SHIPPED_BUILD_PACKAGES) {
    const spec = root.devDependencies?.[name] ?? root.dependencies?.[name];
    if (!spec)
      throw new Error(`${name} is listed as shipped but not a dependency`);
    // The build package itself ships, not its own dependencies.
    const key = snapshotKey(name, spec.version);
    if (key) seen.add(key);
  }
  while (queue.length > 0) {
    const key = queue.shift();
    const snap = lock.snapshots?.[key];
    if (!snap) throw new Error(`lockfile has no snapshot for ${key}`);
    const parent = bareKey(key);
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(snap[field] ?? {})) {
        enqueue(name, version, parent);
      }
    }
  }
  const shipped = new Set([...seen].map(bareKey));
  return { shipped, parents };
}

/** The nearest installed package above `key`, breadth first. */
function installedAncestor(key, parents, installed) {
  const queue = [...(parents.get(key) ?? [])];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const next = queue.shift();
    const found = installed.get(next);
    if (found) return found;
    for (const p of parents.get(next) ?? []) {
      if (!visited.has(p)) {
        visited.add(p);
        queue.push(p);
      }
    }
  }
  return null;
}

/** Every real package directory in the pnpm store, by `name@version`. */
function installedPnpmPackages(storeDir) {
  const out = new Map();
  if (!existsSync(storeDir)) return out;
  for (const entry of readdirSync(storeDir)) {
    const modules = join(storeDir, entry, "node_modules");
    if (!existsSync(modules)) continue;
    const dirs = [];
    for (const name of readdirSync(modules)) {
      if (name.startsWith("@")) {
        for (const sub of readdirSync(join(modules, name))) {
          dirs.push(join(modules, name, sub));
        }
      } else dirs.push(join(modules, name));
    }
    for (const dir of dirs) {
      if (lstatSync(dir).isSymbolicLink()) continue;
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (!pkg.name || !pkg.version) continue;
      out.set(`${pkg.name}@${pkg.version}`, { pkg, dir });
    }
  }
  return out;
}

function repositoryOf(pkg) {
  let url =
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!url) return pkg.homepage ?? null;
  url = url
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^git:\/\//, "https://");
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  if (url.startsWith("github:")) url = `https://github.com/${url.slice(7)}`;
  return url;
}

/**
 * The pnpm part of the inventory: one entry per shipped package.
 *
 * The lockfile's production closure cannot predict what Next's file tracer
 * copies. A production package that requires a name it does not declare
 * resolves through pnpm's hoisted `.pnpm/node_modules` link, which can point
 * at a copy only a dev dependency asked for; the tracer follows it and that
 * copy ships. 1.49.1 shipped `semver@7.8.5` that way, reached in the lockfile
 * only through dev tooling. So with `tracedStoreDir` every package present in
 * the traced store is added as well, its licence read from the full install.
 */
export function pnpmInventory(
  lockText,
  storeDir,
  parseYaml,
  tracedStoreDir = null,
) {
  const lock = parseYaml(lockText);
  const { shipped, parents } = pnpmShipped(lock);
  const installed = installedPnpmPackages(storeDir);
  if (tracedStoreDir !== null) {
    if (!existsSync(tracedStoreDir)) {
      throw new Error(`traced store ${tracedStoreDir} does not exist`);
    }
    for (const [key, copy] of installedPnpmPackages(tracedStoreDir)) {
      shipped.add(key);
      // The tracer copies only the files a module needs, so licence files
      // usually stay behind; the full install holds them.
      if (!installed.has(key)) installed.set(key, copy);
    }
  }
  const entries = [];
  for (const key of [...shipped].sort()) {
    const { name, version } = splitKey(key);
    const found = installed.get(key);
    if (found) {
      entries.push({
        name,
        version,
        licence: licenceOf(found.pkg),
        repository: repositoryOf(found.pkg),
        dir: found.dir,
        installed: true,
      });
      continue;
    }
    // A platform build for another OS or CPU: not installed here, and not in
    // an image built for this one. It is listed under the licence of the
    // installed package that pulls it in.
    const parent = installedAncestor(key, parents, installed);
    entries.push({
      name,
      version,
      licence: parent ? licenceOf(parent.pkg) : null,
      repository: parent ? repositoryOf(parent.pkg) : null,
      dir: null,
      installed: false,
    });
  }
  return entries;
}

// ── The npm tree of the migration CLI ─────────────────────────────────────

export function npmInventory(lockText, installDir = null) {
  const lock = JSON.parse(lockText);
  const entries = [];
  for (const [path, info] of Object.entries(lock.packages ?? {})) {
    if (path === "" || info.dev || info.link) continue;
    const name =
      info.name ?? path.slice(path.lastIndexOf("node_modules/") + 13);
    const dir = installDir ? join(installDir, path) : null;
    const present = dir !== null && existsSync(join(dir, "package.json"));
    const pkg = present
      ? JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
      : null;
    entries.push({
      name,
      version: info.version,
      licence: licenceOf(pkg ?? info),
      repository: pkg ? repositoryOf(pkg) : null,
      dir: present ? dir : null,
      installed: present,
    });
  }
  entries.sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
  return entries;
}

// ── Policy, notices file, bundles ─────────────────────────────────────────

export function policyFailures(entries) {
  return entries
    .map((e) => ({
      e,
      v:
        !e.installed && !e.licence
          ? {
              ok: false,
              why: "not installed here (pnpm install --frozen-lockfile first)",
            }
          : verdict(e.name, e.licence),
    }))
    .filter(({ v }) => !v.ok)
    .map(({ e, v }) => `${e.name}@${e.version}: ${v.why}`);
}

/** The licences in use, and the packages under anything but a permissive one. */
export function licenceSummary(entries) {
  const licences = new Set();
  const notable = new Map();
  for (const e of entries) {
    if (!e.licence) continue;
    licences.add(e.licence);
    const ids = identifiers(e.licence);
    if (ids.every((id) => ALLOWED.has(id))) continue;
    const name = [...LGPL_EXCEPTIONS.keys()].find((p) => e.name.startsWith(p));
    notable.set(name ? `${name}*` : e.name, e.licence);
  }
  return {
    licences: [...licences].sort(),
    notable: [...notable].sort(([a], [b]) => a.localeCompare(b)),
  };
}

const BEGIN =
  "<!-- generated:begin (scripts/third-party-notices.mjs --write) -->";
const END = "<!-- generated:end -->";

function renderGenerated(summary) {
  const lines = [
    BEGIN,
    "",
    "Licences in the shipped dependency tree:",
    "",
    ...summary.licences.map((l) => `- \`${l}\``),
    "",
    "Packages whose licence names anything but a permissive licence:",
    "",
    ...summary.notable.map(
      ([name, licence]) => `- \`${name}\`: \`${licence}\``,
    ),
    "",
    END,
  ];
  return lines.join("\n");
}

function readGenerated(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1) return null;
  return text.slice(start, end + END.length);
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice|copyright)(\b|[._-]|$)/i;

function licenceTexts(dir) {
  if (!dir) return [];
  return readdirSync(dir)
    .filter((f) => LICENCE_FILE.test(f))
    .sort()
    .flatMap((f) => {
      const path = join(dir, f);
      if (!lstatSync(path).isFile()) return [];
      return [{ file: f, text: readFileSync(path, "utf8").trimEnd() }];
    });
}

export function renderBundle(title, entries) {
  const rule = "-".repeat(78);
  const parts = [
    `HealthLog: third-party software, ${title}`,
    "",
    "Generated by scripts/third-party-notices.mjs while the image was built.",
    "Each entry names the package as shipped, its declared licence, where its",
    "source lives, and the licence and notice files the package carries.",
    "See THIRD_PARTY_NOTICES.md for components that come from no package",
    "manager.",
  ];
  for (const e of entries.filter((x) => x.installed)) {
    parts.push("", rule, `Package: ${e.name}@${e.version}`);
    parts.push(`Licence: ${e.licence ?? "none declared"}`);
    if (e.repository) parts.push(`Source: ${e.repository}`);
    const texts = licenceTexts(e.dir);
    if (texts.length === 0) {
      parts.push(
        "",
        "The package carries no licence file. Its declared licence text is",
        `published at https://spdx.org/licenses/ under the identifier above.`,
      );
    }
    for (const t of texts) parts.push("", `== ${t.file}`, "", t.text);
  }
  parts.push("");
  return parts.join("\n");
}

/** `name@version` of every package a bundle lists. */
export function bundlePackages(text) {
  const out = new Set();
  for (const m of text.matchAll(/^Package: (.+)$/gm)) out.add(m[1].trim());
  return out;
}

/**
 * npm packages an SPDX SBOM reports that no bundle lists. The project's own
 * manifests are not third-party.
 */
export function sbomGaps(sbom, listed) {
  const doc = sbom.SPDX ?? sbom;
  const gaps = [];
  for (const p of doc.packages ?? []) {
    const purl = (p.externalRefs ?? []).find(
      (r) => r.referenceType === "purl",
    )?.referenceLocator;
    if (!purl?.startsWith("pkg:npm/")) continue;
    if (OWN_PACKAGES.has(p.name)) continue;
    // A manifest that is not `node_modules/<name>/package.json` belongs to the
    // package around it: a copy vendored inside it (Next's `dist/compiled`)
    // or a fixture folder it ships. That package's licence covers it.
    const path = (p.sourceInfo ?? "").split(": ").pop()?.trim() ?? "";
    if (!path.endsWith(`node_modules/${p.name}/package.json`)) continue;
    const key = `${p.name}@${p.versionInfo}`;
    if (!listed.has(key)) gaps.push(key);
  }
  return [...new Set(gaps)].sort();
}

// ── CLI ───────────────────────────────────────────────────────────────────

async function loadYaml() {
  const { parse } = await import("yaml");
  return parse;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

function args(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === name) out.push(process.argv[i + 1]);
  });
  return out;
}

function fail(lines) {
  for (const l of lines) console.error(l);
  process.exit(1);
}

async function repositoryInventory() {
  const parse = await loadYaml();
  const pnpm = pnpmInventory(
    readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8"),
    join(ROOT, "node_modules", ".pnpm"),
    parse,
  );
  const npm = npmInventory(
    readFileSync(
      join(ROOT, "docker", "prisma-cli", "package-lock.json"),
      "utf8",
    ),
  );
  return [...pnpm, ...npm];
}

async function main() {
  if (process.argv.includes("--bundle-npm")) {
    const dir = arg("--bundle-npm");
    const out = arg("--out");
    const entries = npmInventory(
      readFileSync(join(dir, "package-lock.json"), "utf8"),
      dir,
    );
    const failures = policyFailures(entries.filter((e) => e.installed));
    if (failures.length > 0) fail(["Licence policy refuses:", ...failures]);
    writeFileSync(
      out,
      renderBundle("the migration CLI (/opt/prisma-cli)", entries),
    );
    return;
  }
  if (process.argv.includes("--bundle-pnpm")) {
    const out = arg("--bundle-pnpm");
    const traced = arg("--traced");
    if (!traced)
      fail(["--bundle-pnpm needs --traced <standalone pnpm store>."]);
    const parse = await loadYaml();
    const entries = pnpmInventory(
      readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8"),
      join(ROOT, "node_modules", ".pnpm"),
      parse,
      traced,
    );
    const failures = policyFailures(entries.filter((e) => e.installed));
    if (failures.length > 0) fail(["Licence policy refuses:", ...failures]);
    writeFileSync(out, renderBundle("the application (/app)", entries));
    return;
  }
  if (process.argv.includes("--sbom")) {
    const sbom = JSON.parse(readFileSync(arg("--sbom"), "utf8"));
    const listed = new Set();
    for (const file of args("--inventory")) {
      for (const k of bundlePackages(readFileSync(file, "utf8"))) listed.add(k);
    }
    if (listed.size === 0) fail(["No --inventory bundle listed any package."]);
    const gaps = sbomGaps(sbom, listed);
    if (gaps.length > 0) {
      fail([
        "The image SBOM reports npm packages the shipped licence bundles do not list:",
        ...gaps.map((g) => `  ${g}`),
      ]);
    }
    console.log(
      `SBOM npm packages all listed (${listed.size} bundle entries).`,
    );
    return;
  }

  const entries = await repositoryInventory();
  const writing = process.argv.includes("--write");
  let failures = policyFailures(entries);
  if (writing) {
    // A checkout whose install lags the lockfile can still record the list;
    // the check in CI runs on a fresh install and sees every package.
    const missing = failures.filter((f) => f.includes("not installed here"));
    for (const m of missing) console.warn(`warning: ${m}`);
    failures = failures.filter((f) => !missing.includes(f));
  }
  if (failures.length > 0) {
    fail([
      "Licence policy refuses these shipped packages (see THIRD_PARTY_NOTICES.md, Policy):",
      ...failures.map((f) => `  ${f}`),
    ]);
  }
  const generated = renderGenerated(licenceSummary(entries));
  const current = readFileSync(NOTICES, "utf8");
  if (writing) {
    const block = readGenerated(current);
    if (!block) fail([`${NOTICES} has no generated block to replace.`]);
    writeFileSync(NOTICES, current.replace(block, generated));
    console.log(`Updated ${NOTICES} (${entries.length} shipped packages).`);
    return;
  }
  if (readGenerated(current) !== generated) {
    fail([
      "The licences in the shipped tree differ from THIRD_PARTY_NOTICES.md.",
      "A dependency brought a licence or a non-permissive package the file does",
      "not list. Review it against the policy, then run",
      "  node scripts/third-party-notices.mjs --write",
      "and commit the result. Expected block:",
      "",
      generated,
    ]);
  }
  console.log(
    `Third-party licences match THIRD_PARTY_NOTICES.md (${entries.length} shipped packages).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

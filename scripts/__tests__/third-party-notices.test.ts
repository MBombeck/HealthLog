/**
 * The licence policy and the inventory behind THIRD_PARTY_NOTICES.md.
 *
 * The CI step runs the script against the installed tree; these cases pin
 * the pieces it is made of, and break each rule once to show it can fail.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  bundlePackages,
  licenceOf,
  licenceSummary,
  npmInventory,
  pnpmInventory,
  pnpmShipped,
  policyFailures,
  renderBundle,
  sbomGaps,
  verdict,
} from "../third-party-notices.mjs";

describe("verdict", () => {
  it("allows permissive licences and refuses the GPL family", () => {
    expect(verdict("a", "MIT").ok).toBe(true);
    expect(verdict("a", "Apache-2.0").ok).toBe(true);
    expect(verdict("a", "GPL-3.0-only").ok).toBe(false);
    expect(verdict("a", "AGPL-3.0-or-later").ok).toBe(false);
    expect(verdict("a", "SSPL-1.0").ok).toBe(false);
    expect(verdict("a", "CC-BY-NC-4.0").ok).toBe(false);
    expect(verdict("a", null).ok).toBe(false);
    expect(verdict("a", "UNLICENSED").ok).toBe(false);
  });

  it("reads OR as a choice and AND as a conjunction", () => {
    expect(verdict("node-forge", "(BSD-3-Clause OR GPL-2.0)").ok).toBe(true);
    expect(verdict("a", "MIT AND ISC").ok).toBe(true);
    expect(verdict("a", "MIT AND GPL-2.0").ok).toBe(false);
    expect(verdict("a", "(GPL-2.0 OR AGPL-3.0)").ok).toBe(false);
  });

  it("allows file-level copyleft, and the LGPL only for the named libraries", () => {
    expect(verdict("web-push", "MPL-2.0").ok).toBe(true);
    expect(verdict("elkjs", "EPL-2.0").ok).toBe(true);
    expect(
      verdict("@img/sharp-libvips-linux-x64", "LGPL-3.0-or-later").ok,
    ).toBe(true);
    expect(verdict("some-lib", "LGPL-3.0-or-later").ok).toBe(false);
  });
});

describe("licenceOf", () => {
  it("reads the shapes package.json files use", () => {
    expect(licenceOf({ license: "MIT" })).toBe("MIT");
    expect(licenceOf({ license: { type: "ISC" } })).toBe("ISC");
    expect(
      licenceOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }),
    ).toBe("(MIT OR Apache-2.0)");
    expect(licenceOf({ license: "MIT and ISC" })).toBe("MIT AND ISC");
    expect(licenceOf({})).toBeNull();
  });
});

describe("pnpmShipped", () => {
  const lock = parse(`
importers:
  .:
    dependencies:
      app-dep:
        specifier: ^1.0.0
        version: 1.0.0(peer@2.0.0)
    devDependencies:
      tailwindcss:
        specifier: 4.0.0
        version: 4.0.0
      vitest:
        specifier: 5.0.0
        version: 5.0.0
snapshots:
  app-dep@1.0.0(peer@2.0.0):
    dependencies:
      child: 3.0.0
      alias-dep: real-name@1.2.3
    optionalDependencies:
      native-linux-x64: 1.0.0
  child@3.0.0: {}
  real-name@1.2.3: {}
  native-linux-x64@1.0.0: {}
  tailwindcss@4.0.0:
    dependencies:
      build-only: 1.0.0
  vitest@5.0.0: {}
  build-only@1.0.0: {}
`);

  it("takes the production closure, aliases resolved, plus the shipped build packages alone", () => {
    // tailwindcss ships its CSS banner; its own dependencies do not ship.
    const { shipped, parents } = pnpmShipped({
      ...lock,
      importers: {
        ".": {
          ...lock.importers["."],
          devDependencies: {
            ...lock.importers["."].devDependencies,
            "@tesseract.js-data/deu": { version: "1.0.0" },
            "@tesseract.js-data/eng": { version: "1.0.0" },
            "pdfjs-dist": { version: "5.0.0" },
            "tw-animate-css": { version: "1.0.0" },
          },
        },
      },
    });
    expect([...shipped].sort()).toEqual(
      [
        "@tesseract.js-data/deu@1.0.0",
        "@tesseract.js-data/eng@1.0.0",
        "app-dep@1.0.0",
        "child@3.0.0",
        "native-linux-x64@1.0.0",
        "pdfjs-dist@5.0.0",
        "real-name@1.2.3",
        "tailwindcss@4.0.0",
        "tw-animate-css@1.0.0",
      ].sort(),
    );
    expect(parents.get("native-linux-x64@1.0.0")).toEqual(["app-dep@1.0.0"]);
  });
});

describe("npmInventory", () => {
  it("skips the root and dev packages and keeps the declared licence", () => {
    const entries = npmInventory(
      JSON.stringify({
        packages: {
          "": { name: "cli" },
          "node_modules/prisma": { version: "7.0.0", license: "Apache-2.0" },
          "node_modules/a/node_modules/b": { version: "1.0.0", license: "MIT" },
          "node_modules/dev-thing": {
            version: "1.0.0",
            license: "MIT",
            dev: true,
          },
        },
      }),
    );
    expect(entries.map((e) => `${e.name}@${e.version} ${e.licence}`)).toEqual([
      "b@1.0.0 MIT",
      "prisma@7.0.0 Apache-2.0",
    ]);
  });
});

describe("policyFailures and licenceSummary", () => {
  const entries = [
    { name: "a", version: "1", licence: "MIT" },
    { name: "b", version: "1", licence: "GPL-3.0-only" },
    {
      name: "@img/sharp-libvips-linux-x64",
      version: "1",
      licence: "LGPL-3.0-or-later",
    },
    {
      name: "@img/sharp-libvips-linux-arm64",
      version: "1",
      licence: "LGPL-3.0-or-later",
    },
    { name: "web-push", version: "3", licence: "MPL-2.0" },
  ];

  it("names each refused package with its licence", () => {
    expect(policyFailures(entries)).toEqual(["b@1: licence GPL-3.0-only"]);
  });

  it("lists the licences and folds the named LGPL family into one row", () => {
    const summary = licenceSummary(entries);
    expect(summary.licences).toEqual([
      "GPL-3.0-only",
      "LGPL-3.0-or-later",
      "MIT",
      "MPL-2.0",
    ]);
    expect(summary.notable).toEqual([
      ["@img/sharp-libvips-*", "LGPL-3.0-or-later"],
      ["b", "GPL-3.0-only"],
      ["web-push", "MPL-2.0"],
    ]);
  });
});

describe("the SBOM check", () => {
  const bundle = renderBundle("test", [
    {
      name: "react",
      version: "19.0.0",
      licence: "MIT",
      repository: null,
      dir: null,
      installed: true,
    },
  ]);

  it("lists every package the bundle carries", () => {
    expect(bundlePackages(bundle)).toEqual(new Set(["react@19.0.0"]));
  });

  const pkg = (name: string, version: string, path: string) => ({
    name,
    versionInfo: version,
    sourceInfo: `acquired package info from installed node module manifest file: ${path}`,
    externalRefs: [
      { referenceType: "purl", referenceLocator: `pkg:npm/${name}@${version}` },
    ],
  });

  it("reports an npm package the bundles miss, and nothing else", () => {
    const sbom = {
      SPDX: {
        packages: [
          pkg(
            "react",
            "19.0.0",
            "/app/node_modules/.pnpm/react@19.0.0/node_modules/react/package.json",
          ),
          pkg(
            "left-pad",
            "1.3.0",
            "/app/node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/package.json",
          ),
          pkg("healthlog", "1.49.0", "/app/package.json"),
          pkg(
            "busboy",
            "UNKNOWN",
            "/app/node_modules/next/dist/compiled/busboy/package.json",
          ),
          pkg(
            "benchmark",
            "1.0.0",
            "/opt/prisma-cli/node_modules/fast-uri/benchmark/package.json",
          ),
          {
            name: "tzdata",
            versionInfo: "2026a",
            externalRefs: [
              {
                referenceType: "purl",
                referenceLocator: "pkg:deb/debian/tzdata@2026a",
              },
            ],
          },
        ],
      },
    };
    expect(sbomGaps(sbom, bundlePackages(bundle))).toEqual(["left-pad@1.3.0"]);
  });
});

describe("pnpmInventory with the traced standalone store", () => {
  const lockText = `
importers:
  .:
    dependencies:
      app-dep:
        specifier: 1.0.0
        version: 1.0.0
    devDependencies:
      dev-tool:
        specifier: 1.0.0
        version: 1.0.0
      "@tesseract.js-data/deu": { specifier: 1.0.0, version: 1.0.0 }
      "@tesseract.js-data/eng": { specifier: 1.0.0, version: 1.0.0 }
      pdfjs-dist: { specifier: 5.0.0, version: 5.0.0 }
      tailwindcss: { specifier: 4.0.0, version: 4.0.0 }
      tw-animate-css: { specifier: 1.0.0, version: 1.0.0 }
snapshots:
  app-dep@1.0.0: {}
  dev-tool@1.0.0:
    dependencies:
      semver: 7.8.5
  semver@7.8.5: {}
`;
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A pnpm store with one real directory per `[name, version, licence]`. */
  function store(packages: [string, string, string][], licenceFile: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "tpn-store-"));
    dirs.push(dir);
    for (const [name, version, license] of packages) {
      const pkgDir = join(dir, `${name}@${version}`, "node_modules", name);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name, version, license }),
      );
      if (licenceFile)
        writeFileSync(join(pkgDir, "LICENSE"), `${license} text`);
    }
    return dir;
  }

  const full = () =>
    store(
      [
        ["app-dep", "1.0.0", "MIT"],
        ["dev-tool", "1.0.0", "MIT"],
        ["semver", "7.8.5", "ISC"],
      ],
      true,
    );

  it("lists a dev-graph package the tracer copied, with the full install's licence file", () => {
    // The tracer reached semver@7.8.5 through pnpm's hoisted link; the
    // lockfile's production graph never names it.
    const traced = store(
      [
        ["app-dep", "1.0.0", "MIT"],
        ["semver", "7.8.5", "ISC"],
      ],
      false,
    );
    const entries = pnpmInventory(lockText, full(), parse, traced);
    const listed = bundlePackages(renderBundle("test", entries));
    expect(listed).toEqual(new Set(["app-dep@1.0.0", "semver@7.8.5"]));
    expect(renderBundle("test", entries)).toContain("ISC text");
    // Without the traced store the same package is missing: the 1.49.1 gap.
    expect(
      bundlePackages(
        renderBundle("test", pnpmInventory(lockText, full(), parse)),
      ),
    ).toEqual(new Set(["app-dep@1.0.0"]));
  });

  it("holds a traced package to the licence policy", () => {
    const traced = store([["semver", "7.8.5", "GPL-3.0-only"]], false);
    const fullDir = store([["app-dep", "1.0.0", "MIT"]], true);
    const entries = pnpmInventory(lockText, fullDir, parse, traced);
    // The bundle step holds the installed entries to the policy.
    expect(policyFailures(entries.filter((e) => e.installed))).toEqual([
      "semver@7.8.5: licence GPL-3.0-only",
    ]);
  });

  it("refuses a traced store that is not there", () => {
    expect(() =>
      pnpmInventory(lockText, full(), parse, join(tmpdir(), "tpn-missing-x")),
    ).toThrow(/does not exist/);
  });
});

import { createHash } from "node:crypto";

import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  WALLET_ASSET_HASHES,
  WALLET_ASSET_SIZES,
  loadWalletAssets,
} from "../assets";
import {
  WALLET_PASS_PATHS,
  assemblePkpass,
  buildPassFiles,
  freshStringsNonce,
  passContentHash,
  passManifest,
} from "../bundle";
import { buildPassContent } from "../content";
import { escapeStringsLiteral, serialisePassStrings } from "../strings";

import { NONCE, SAMPLE_INPUT } from "./fixture";
import { parsePassStrings } from "./pass-strings-reader";

const SIGNATURE = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]);

function sha1(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

/** Width and height from a PNG's IHDR. */
function pngSize(bytes: Uint8Array): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(
    [...bytes.subarray(1, 4)].map((c) => String.fromCharCode(c)).join(""),
  ).toBe("PNG");
  return [view.getUint32(16), view.getUint32(20)];
}

describe("strings tables", () => {
  it("round-trip quotes, backslashes, line breaks, umlauts and Hangul", () => {
    const entries: Array<[string, string]> = [
      ['He said "no"', 'Er sagte "nein"'],
      ["C:\\path\\x", "D:\\pfad"],
      ["two\nlines", "zwei\nZeilen"],
      ["tab\there", "Tab\thier"],
      ["Größe", "크기 (혈액형)"],
    ];
    const parsed = parsePassStrings(serialisePassStrings(NONCE, entries));
    expect(parsed.get("_n")).toBe(NONCE);
    for (const [key, value] of entries) expect(parsed.get(key)).toBe(value);
    expect(escapeStringsLiteral('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
  });

  it("keeps the first value of a repeated key and refuses a bad nonce", () => {
    const parsed = parsePassStrings(
      serialisePassStrings(NONCE, [
        ["x", "first"],
        ["x", "second"],
      ]),
    );
    expect(parsed.get("x")).toBe("first");
    expect(() => serialisePassStrings("short", [])).toThrow();
  });

  it("draws a fresh nonce for every build", () => {
    const a = freshStringsNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(freshStringsNonce()).not.toBe(a);
  });
});

describe("the images", () => {
  it("are the pinned files at Apple's sizes", () => {
    const assets = loadWalletAssets();
    expect([...assets.keys()].sort()).toEqual(
      Object.keys(WALLET_ASSET_SIZES).sort(),
    );
    for (const [name, bytes] of assets) {
      expect(sha1(bytes), name).toBe(WALLET_ASSET_HASHES[name]);
      expect(pngSize(bytes), name).toEqual(WALLET_ASSET_SIZES[name]);
    }
    // The artwork carries most of the pass's weight; its share is fixed so
    // the whole stays under the budget below with room for the text.
    expect(assets.get("artwork@2x.png")!.byteLength).toBeLessThanOrEqual(
      120 * 1024,
    );
    expect(assets.get("artwork@3x.png")!.byteLength).toBeLessThanOrEqual(
      220 * 1024,
    );
  });
});

describe("the bundle", () => {
  const content = buildPassContent(SAMPLE_INPUT);

  it("holds only the closed set of paths, every language included", () => {
    const files = buildPassFiles(content, NONCE);
    expect([...files.keys()].sort()).toEqual([...WALLET_PASS_PATHS].sort());
    expect(() =>
      buildPassFiles(
        content,
        NONCE,
        new Map([["thumbnail.png", new Uint8Array()]]),
      ),
    ).toThrow(/not a pass file/);
  });

  it("lists every file's SHA-1 in the manifest", () => {
    const files = buildPassFiles(content, NONCE);
    const manifest = JSON.parse(new TextDecoder().decode(passManifest(files)));
    expect(Object.keys(manifest)).toEqual([...files.keys()].sort());
    for (const [path, bytes] of files) expect(manifest[path]).toBe(sha1(bytes));
  });

  it("is the same bytes for the same input", () => {
    const build = () => {
      const files = buildPassFiles(buildPassContent(SAMPLE_INPUT), NONCE);
      return assemblePkpass(files, passManifest(files), SIGNATURE);
    };
    const a = build();
    expect(Buffer.from(build()).equals(Buffer.from(a))).toBe(true);
  });

  it("changes the string tables, not the content hash, with a new nonce", () => {
    const a = buildPassFiles(content, NONCE);
    const b = buildPassFiles(content, "f".repeat(32));
    expect(sha1(a.get("de.lproj/pass.strings") as Uint8Array)).not.toBe(
      sha1(b.get("de.lproj/pass.strings") as Uint8Array),
    );
    expect(passContentHash(a)).toBe(passContentHash(b));
    const changed = buildPassFiles(
      buildPassContent({ ...SAMPLE_INPUT, asOfDay: "2026-11-25" }),
      NONCE,
    );
    expect(passContentHash(changed)).not.toBe(passContentHash(a));
  });

  it("zips into a pass under the size budget that unzips to the same files", () => {
    const files = buildPassFiles(content, NONCE);
    const manifest = passManifest(files);
    const pkpass = assemblePkpass(files, manifest, SIGNATURE);
    expect(pkpass.byteLength).toBeLessThanOrEqual(400 * 1024);
    const unzipped = unzipSync(pkpass);
    expect(Object.keys(unzipped).slice(0, 2)).toEqual([
      "manifest.json",
      "signature",
    ]);
    expect(
      Buffer.from(unzipped["manifest.json"]).equals(Buffer.from(manifest)),
    ).toBe(true);
    for (const [path, bytes] of files) {
      expect(Buffer.from(unzipped[path]).equals(Buffer.from(bytes)), path).toBe(
        true,
      );
    }
  });
});

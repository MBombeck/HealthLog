import { deflateRawSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  buildWatchActivity,
  zipOne,
} from "../../../../tests/fixtures/fit/build-fit";
import {
  FIT_DECOMPRESSED_MAX_BYTES,
  FIT_UPLOAD_MAX_BYTES,
  unwrapFitUpload,
} from "../container";
import { FitImportError } from "../errors";

const FILE = buildWatchActivity({
  start: new Date("2026-10-01T08:00:00Z"),
  seconds: 120,
});

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof FitImportError ? err.code : `other:${String(err)}`;
  }
}

describe("unwrapFitUpload", () => {
  it("passes a bare FIT file through", () => {
    const out = unwrapFitUpload(FILE);
    expect(out.container).toBe("fit");
    expect(out.fit.equals(FILE)).toBe(true);
  });

  it("unpacks a .fit.gz", () => {
    const out = unwrapFitUpload(gzipSync(FILE));
    expect(out.container).toBe("gzip");
    expect(out.fit.equals(FILE)).toBe(true);
  });

  it("unpacks Garmin's one-member ZIP, deflated or stored", () => {
    for (const stored of [false, true]) {
      const out = unwrapFitUpload(
        zipOne("1234567890_ACTIVITY.fit", FILE, { stored }),
      );
      expect(out.container).toBe("zip");
      expect(out.fit.equals(FILE)).toBe(true);
    }
  });

  it("ignores folder and resource-fork entries next to the .fit", () => {
    const out = unwrapFitUpload(
      zipOne("ride.FIT", FILE, {
        extra: [
          ["__MACOSX/._ride.FIT", Buffer.from("junk")],
          ["readme.txt", Buffer.from("hello")],
        ],
      }),
    );
    expect(out.fit.equals(FILE)).toBe(true);
  });

  it("refuses a ZIP with no .fit or more than one", () => {
    expect(
      codeOf(() => unwrapFitUpload(zipOne("notes.txt", Buffer.from("x")))),
    ).toBe("archive_invalid");
    expect(
      codeOf(() =>
        unwrapFitUpload(zipOne("a.fit", FILE, { extra: [["b.fit", FILE]] })),
      ),
    ).toBe("archive_invalid");
  });

  it("stops a gzip bomb at the output ceiling", () => {
    const bomb = gzipSync(Buffer.alloc(FIT_DECOMPRESSED_MAX_BYTES + 1024));
    expect(bomb.length).toBeLessThan(FIT_UPLOAD_MAX_BYTES);
    expect(codeOf(() => unwrapFitUpload(bomb))).toBe("too_large");
  });

  it("stops a ZIP bomb whose directory understates the member", () => {
    const big = Buffer.alloc(FIT_DECOMPRESSED_MAX_BYTES + 1024);
    const zip = zipOne("bomb.fit", big, { declaredSize: 1000 });
    expect(codeOf(() => unwrapFitUpload(zip))).toBe("too_large");
  });

  it("refuses a member whose declared size is over the ceiling", () => {
    const zip = zipOne("big.fit", FILE, {
      declaredSize: FIT_DECOMPRESSED_MAX_BYTES + 1,
    });
    expect(codeOf(() => unwrapFitUpload(zip))).toBe("too_large");
  });

  it("refuses an upload over the cap", () => {
    expect(
      codeOf(() => unwrapFitUpload(Buffer.alloc(FIT_UPLOAD_MAX_BYTES + 1))),
    ).toBe("too_large");
  });

  it("refuses anything that is not FIT, gzip or ZIP", () => {
    expect(codeOf(() => unwrapFitUpload(Buffer.from("<gpx></gpx>")))).toBe(
      "unsupported_file",
    );
  });

  it("refuses a gzip or ZIP that does not hold a FIT file", () => {
    expect(codeOf(() => unwrapFitUpload(gzipSync(Buffer.from("hello"))))).toBe(
      "not_fit",
    );
    expect(codeOf(() => unwrapFitUpload(zipOne("x.fit", gzipSync(FILE))))).toBe(
      "not_fit",
    );
  });

  it("refuses a damaged deflate stream", () => {
    const zip = zipOne("a.fit", FILE);
    const broken = Buffer.from(zip);
    // Corrupt the start of the compressed data (after the 30-byte header + name).
    broken.fill(0xff, 35, 45);
    expect(["archive_invalid", "not_fit"]).toContain(
      codeOf(() => unwrapFitUpload(broken)),
    );
  });

  it("never inflates a raw deflate payload past the ceiling", () => {
    // Sanity: the payload really is small.
    expect(
      deflateRawSync(Buffer.alloc(FIT_DECOMPRESSED_MAX_BYTES * 2)).length,
    ).toBeLessThan(FIT_UPLOAD_MAX_BYTES);
  });

  it("inflates no more than an activity's worth: 8 MiB", () => {
    expect(FIT_DECOMPRESSED_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});

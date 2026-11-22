/**
 * One upload path for every staged file import (`lib/import/staged-upload.ts`).
 *
 * The flow (rate bucket, declared length, body to disk, dedupe, worker check,
 * busy lock, queue, audit) used to exist five times, and the copies had
 * drifted: a 413 with an error code on two routes and without on three, a
 * 422 for a file the stream found too large on two, a declared-length check
 * without the multipart envelope reserve on two, and four different rate
 * buckets. Three rules keep it one path:
 *
 *   1. `streamMultipartToDisk` has exactly one caller, the shared handler.
 *   2. The routes that call the shared handler are a closed list, each one
 *      outside the proxy matcher so nothing reads the body first.
 *   3. No route under an `import` path segment reads a multipart body by any
 *      other means.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PROXY_BYPASS_ROUTES } from "@/lib/http/proxy-bypass-routes";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const SHARED_HANDLER = "lib/import/staged-upload.ts";
const STREAM_MODULE = "lib/multipart/stream-to-disk.ts";

/** The staged upload routes, by route file. */
const STAGED_UPLOAD_ROUTES = [
  "app/api/admin/import-apple-health-export/route.ts",
  "app/api/import/apple-health-export/route.ts",
  "app/api/import/fhir-bundle/route.ts",
  "app/api/import/fit/route.ts",
  "app/api/import/gadgetbridge/route.ts",
  "app/api/import/health-connect-export/route.ts",
];

const STREAM_CALL = /\bstreamMultipartToDisk\s*\(/;
const HANDLER_CALL = /\bhandleStagedUpload\s*\(/;
/** Any other way to read a multipart body. */
const MULTIPART_READ =
  /\.formData\s*\(|\bstreamMultipartToDisk\b|\bparseBoundary\b|multipart\/form-data/;
const IMPORT_ROUTE = /^app\/api\/(?:.+\/)?import[^/]*\/(?:.+\/)?route\.tsx?$/;

function routePath(file: string): string {
  return `/${file.replace(/^app\//, "").replace(/\/route\.tsx?$/, "")}`;
}

describe("staged file uploads take one path", () => {
  const files = walkSourceFiles(SRC, { floor: 3000 }).filter(
    (file) =>
      !file.startsWith("generated/") &&
      !file.includes("__tests__/") &&
      !/\.test\.tsx?$/.test(file),
  );
  const read = (file: string) => stripComments(readSourceText(join(SRC, file)));

  it("the matchers fire on planted sources", () => {
    expect(STREAM_CALL.test("await streamMultipartToDisk(\n  body,")).toBe(
      true,
    );
    expect(HANDLER_CALL.test("handleStagedUpload(request, spec)")).toBe(true);
    expect(MULTIPART_READ.test("const form = await request.formData();")).toBe(
      true,
    );
    expect(IMPORT_ROUTE.test("app/api/import/fit/route.ts")).toBe(true);
    expect(
      IMPORT_ROUTE.test("app/api/admin/import-apple-health-export/route.ts"),
    ).toBe(true);
    expect(IMPORT_ROUTE.test("app/api/measurements/batch/route.ts")).toBe(
      false,
    );
  });

  it("only the shared handler streams a multipart body to disk", () => {
    const callers = files.filter(
      (file) => file !== STREAM_MODULE && STREAM_CALL.test(read(file)),
    );
    requireFloor("streamMultipartToDisk callers", callers, 1);
    expect(callers).toEqual([SHARED_HANDLER]);
  });

  it("the routes on the shared handler are the closed list, all outside the proxy matcher", () => {
    const routes = files.filter(
      (file) =>
        /^app\/.+\/route\.tsx?$/.test(file) && HANDLER_CALL.test(read(file)),
    );
    requireFloor(
      "handleStagedUpload routes",
      routes,
      STAGED_UPLOAD_ROUTES.length,
    );
    expect([...routes].sort()).toEqual(STAGED_UPLOAD_ROUTES);
    for (const file of routes) {
      expect(PROXY_BYPASS_ROUTES, file).toContain(routePath(file));
    }
  });

  it("no import route reads a multipart body around the shared handler", () => {
    const importRoutes = requireFloor(
      "import routes",
      files.filter((file) => IMPORT_ROUTE.test(file)),
      STAGED_UPLOAD_ROUTES.length,
    );
    const offenders = importRoutes.filter((file) => {
      const code = read(file);
      return MULTIPART_READ.test(code) && !HANDLER_CALL.test(code);
    });
    expect(offenders).toEqual([]);
  });
});

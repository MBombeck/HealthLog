/**
 * `scripts/import-documents.mjs` against recorded-shape fixtures of the two
 * source APIs and a stand-in HealthLog, all on local HTTP servers.
 *
 * The fixtures are the shapes the script depends on (Paperless-ngx API v10
 * pagination, tag and document-type lookups, `?original=true` downloads;
 * Papra's organization-scoped document list, tags and `/file`), so a change
 * on either side shows up here as a fixture to refresh rather than as a user
 * report. The HealthLog stand-in answers the upload contract the real route
 * speaks: 201, 200 duplicate, 200 deleted, 413, 429 with Retry-After, 403
 * `module.disabled`.
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts/import-documents.mjs");
const PDF = Buffer.from("%PDF-1.7\n%fixture\n%%EOF\n");

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))),
  );
});

type Handler = (
  req: IncomingMessage,
  url: URL,
  body: Buffer,
) => Promise<{
  status: number;
  json?: unknown;
  bytes?: Buffer;
  headers?: Record<string, string>;
}>;

async function serve(handler: Handler): Promise<string> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? "/", "http://localhost");
    const r = await handler(req, url, Buffer.concat(chunks));
    const headers: Record<string, string> = { ...(r.headers ?? {}) };
    if (r.json !== undefined) headers["content-type"] = "application/json";
    res.writeHead(r.status, headers);
    res.end(r.json !== undefined ? JSON.stringify(r.json) : (r.bytes ?? ""));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function runScript(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

interface Received {
  auth: string | undefined;
  fields: Record<string, string>;
  filename: string | null;
  size: number;
}

/**
 * A HealthLog stand-in. Keys stored documents by source key the way the real
 * route does, answers the first upload with a 429, and refuses keys listed as
 * deleted or too large.
 */
async function healthlog(
  opts: {
    deleted?: string[];
    tooLarge?: string[];
    moduleOff?: boolean;
    /** An older HealthLog with no lookup route. */
    noLookup?: boolean;
    /** The address redirects elsewhere (http → https, a moved host). */
    redirect?: string;
  } = {},
) {
  const stored = new Set<string>();
  const received: Received[] = [];
  const lookups: string[] = [];
  let throttled = false;
  const url = await serve(async (req, url, body) => {
    if (opts.redirect) {
      return {
        status: 301,
        headers: { location: `${opts.redirect}${url.pathname}` },
      };
    }
    const queryKey = `${url.searchParams.get("sourceSystem")}:${url.searchParams.get("sourceId")}`;
    if (
      url.pathname === "/api/documents/inbound/source" &&
      req.method === "GET" &&
      !opts.noLookup
    ) {
      lookups.push(queryKey);
      const deleted = opts.deleted?.includes(queryKey) ?? false;
      const known = deleted || stored.has(queryKey);
      return {
        status: 200,
        json: {
          data: { known, id: known ? queryKey : null, deleted },
          error: null,
        },
      };
    }
    if (url.pathname !== "/api/documents/inbound" || req.method !== "POST") {
      return { status: 404, json: { data: null, error: "Not found" } };
    }
    if (opts.moduleOff) {
      return {
        status: 403,
        json: {
          data: null,
          error: 'Module "inboundDocuments" is not enabled',
          meta: { errorCode: "module.disabled" },
        },
      };
    }
    if (!throttled) {
      throttled = true;
      return {
        status: 429,
        headers: { "retry-after": "0" },
        json: {
          data: null,
          error: "Too many uploads.",
          meta: { errorCode: "documents.inbound.rateLimited" },
        },
      };
    }
    const form = await new Response(body, {
      headers: { "content-type": req.headers["content-type"] ?? "" },
    }).formData();
    const fields: Record<string, string> = {};
    let filename: string | null = null;
    let size = 0;
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") fields[k] = v;
      else {
        filename = v.name;
        size = v.size;
      }
    }
    // The key rides the query string, where HealthLog reads it first.
    fields.sourceSystem = url.searchParams.get("sourceSystem") ?? "";
    fields.sourceId = url.searchParams.get("sourceId") ?? "";
    received.push({ auth: req.headers.authorization, fields, filename, size });
    const key = queryKey;
    if (opts.tooLarge?.includes(key)) {
      return {
        status: 413,
        json: {
          data: null,
          error: "File is too large.",
          meta: { reason: "fileTooLarge", maxFileBytes: 26_214_400 },
        },
      };
    }
    if (opts.deleted?.includes(key)) {
      return {
        status: 200,
        json: {
          data: { id: null, duplicate: true, deleted: true },
          error: null,
          meta: { duplicate: true, deleted: true },
        },
      };
    }
    if (stored.has(key)) {
      return {
        status: 200,
        json: {
          data: { id: key, duplicate: true },
          error: null,
          meta: { duplicate: true },
        },
      };
    }
    stored.add(key);
    return {
      status: 201,
      json: { data: { id: key, duplicate: false }, error: null },
    };
  });
  return { url, received, lookups };
}

/** Paperless-ngx v10 stand-in: two pages of documents, one outside the tag. */
async function paperless() {
  const seen: { path: string; auth?: string; accept?: string }[] = [];
  const url = await serve(async (req, url) => {
    seen.push({
      path: url.pathname + url.search,
      auth: req.headers.authorization,
      accept: req.headers.accept,
    });
    const base = `http://${req.headers.host}`;
    if (url.pathname === "/api/tags/") {
      return {
        status: 200,
        json: {
          count: 1,
          next: null,
          results: [{ id: 7, name: "HealthLog" }],
        },
      };
    }
    if (url.pathname === "/api/document_types/") {
      return {
        status: 200,
        json: { count: 1, next: null, results: [{ id: 3, name: "Labor" }] },
      };
    }
    if (url.pathname === "/api/documents/") {
      if (url.searchParams.get("page") === "2") {
        return {
          status: 200,
          json: {
            count: 3,
            next: null,
            results: [
              {
                id: 3,
                title: "Car insurance",
                created: "2024-05-01",
                added: "2024-05-02T10:00:00Z",
                tags: [9],
                document_type: null,
                original_file_name: "car.pdf",
              },
            ],
          },
        };
      }
      const next = new URL(url.toString(), base);
      next.searchParams.set("page", "2");
      return {
        status: 200,
        json: {
          count: 3,
          // Deliberately another origin, as behind a reverse proxy.
          next: `https://paperless.internal${next.pathname}${next.search}`,
          results: [
            {
              id: 1,
              title: "Blutbild März",
              created: "2024-03-05",
              added: "2024-03-06T08:00:00Z",
              tags: [7],
              document_type: 3,
              original_file_name: "blutbild.pdf",
            },
            {
              id: 2,
              // Blank in the source: the file name stands in.
              title: "   ",
              created: null,
              added: "2024-04-01T09:30:00Z",
              tags: [7],
              document_type: null,
              original_file_name: "brief.pdf",
            },
          ],
        },
      };
    }
    const download = /^\/api\/documents\/(\d+)\/download\/$/.exec(url.pathname);
    if (download) {
      return {
        status: 200,
        bytes: PDF,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="doc-${download[1]}.pdf"`,
        },
      };
    }
    const metadata = /^\/api\/documents\/(\d+)\/metadata\/$/.exec(url.pathname);
    if (metadata) {
      return { status: 200, json: { original_size: 1_048_576 } };
    }
    return { status: 404, json: { detail: "Not found." } };
  });
  return { url, seen };
}

/** Papra stand-in: one organization, a tag, three documents. */
async function papra() {
  const seen: { path: string; auth?: string }[] = [];
  const url = await serve(async (req, url) => {
    seen.push({
      path: url.pathname + url.search,
      auth: req.headers.authorization,
    });
    const org = "/api/organizations/org_1";
    if (url.pathname === `${org}/tags`) {
      return {
        status: 200,
        json: {
          tags: [
            { id: "tag_h", name: "Health" },
            { id: "tag_l", name: "Lab" },
          ],
        },
      };
    }
    if (url.pathname === `${org}/documents`) {
      return {
        status: 200,
        json: {
          documentsCount: 3,
          documents: [
            {
              id: "doc_a",
              name: "Impfpass.pdf",
              originalName: "impfpass.pdf",
              originalSize: 2048,
              createdAt: "2025-01-10T12:00:00.000Z",
              documentDate: "2019-06-01",
              tags: [{ id: "tag_h", name: "Health" }],
            },
            {
              id: "doc_b",
              name: "Labor.pdf",
              originalName: "labor.pdf",
              originalSize: 4096,
              createdAt: "2025-02-10T12:00:00.000Z",
              tags: [
                { id: "tag_h", name: "Health" },
                { id: "tag_l", name: "Lab" },
              ],
            },
            {
              id: "doc_old",
              name: "Old.pdf",
              originalName: "old.pdf",
              originalSize: 100,
              createdAt: "2015-02-10T12:00:00.000Z",
              documentDate: "2015-02-10",
              tags: [{ id: "tag_h", name: "Health" }],
            },
          ],
        },
      };
    }
    if (
      /^\/api\/organizations\/org_1\/documents\/[\w]+\/file$/.test(url.pathname)
    ) {
      return {
        status: 200,
        bytes: PDF,
        headers: { "content-type": "application/pdf" },
      };
    }
    return { status: 404, json: { error: "not found" } };
  });
  return { url, seen };
}

describe("import-documents.mjs — Paperless-ngx", () => {
  it("imports the tagged documents with their title, date, kind and source key", async () => {
    const hl = await healthlog();
    const pl = await paperless();
    const env = { HEALTHLOG_TOKEN: "hlk_test", PAPERLESS_TOKEN: "pl_test" };
    const args = [
      "paperless",
      "--paperless-url",
      pl.url,
      "--healthlog-url",
      hl.url,
      "--tag",
      "HealthLog",
      "--kind-map",
      "Labor=LAB_RESULT",
    ];
    const first = await runScript(args, env);

    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    // The first upload met a 429 and was sent again, not dropped.
    expect(hl.received).toHaveLength(2);
    expect(hl.received[0]).toMatchObject({
      auth: "Bearer hlk_test",
      filename: "blutbild.pdf",
      size: PDF.byteLength,
      fields: {
        title: "Blutbild März",
        documentDate: "2024-03-05",
        kind: "LAB_RESULT",
        sourceSystem: "PAPERLESS",
        sourceId: "1",
        aiRead: "defer",
      },
    });
    // No created date: filed under the day it was added, and said so.
    expect(hl.received[1].fields.documentDate).toBe("2024-04-01");
    expect(hl.received[1].fields.title).toBe("brief");
    expect(hl.received[1].fields.kind).toBeUndefined();
    expect(first.stdout).toMatch(/Imported: 2/);
    expect(first.stdout).toMatch(/filed under the day it was added/);
    expect(first.stdout).toMatch(/without automatic AI reading/);

    // The API contract the script leans on.
    const docs = pl.seen.filter((s) => s.path.startsWith("/api/documents/?"));
    expect(docs[0].path).toContain("tags__id__all=7");
    // API v9: the lowest the current Paperless-ngx releases accept.
    expect(docs[0].accept).toBe("application/json; version=9");
    expect(docs[0].auth).toBe("Token pl_test");
    // `next` was followed on the source's own origin.
    expect(docs[1].path).toContain("page=2");
    expect(
      pl.seen.filter((s) => s.path.includes("/download/")).map((s) => s.path),
    ).toEqual([
      "/api/documents/1/download/?original=true",
      "/api/documents/2/download/?original=true",
    ]);

    // A second run changes nothing: HealthLog already holds both, and the
    // lookup says so before anything is downloaded or uploaded again.
    const downloadsBefore = pl.seen.filter((s) =>
      s.path.includes("/download/"),
    ).length;
    const second = await runScript(args, env);
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/Imported: 0/);
    expect(second.stdout).toMatch(/Already in HealthLog: 2/);
    expect(pl.seen.filter((s) => s.path.includes("/download/")).length).toBe(
      downloadsBefore,
    );
    expect(hl.received).toHaveLength(2);
    expect(hl.lookups).toContain("PAPERLESS:1");
  });

  it("leaves a document deleted in HealthLog alone", async () => {
    const hl = await healthlog({ deleted: ["PAPERLESS:2"] });
    const pl = await paperless();
    const res = await runScript(
      [
        "paperless",
        "--paperless-url",
        pl.url,
        "--healthlog-url",
        hl.url,
        "--tag",
        "healthlog",
      ],
      { HEALTHLOG_TOKEN: "hlk_test", PAPERLESS_TOKEN: "pl_test" },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Imported: 1/);
    expect(res.stdout).toMatch(/Deleted in HealthLog, left alone: 1/);
  });

  it("stops with a plain instruction when the vault is switched off", async () => {
    const hl = await healthlog({ moduleOff: true });
    const pl = await paperless();
    const res = await runScript(
      ["paperless", "--paperless-url", pl.url, "--healthlog-url", hl.url],
      { HEALTHLOG_TOKEN: "hlk_test", PAPERLESS_TOKEN: "pl_test" },
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/Turn on Documents in Settings/);
  });

  it("lists sizes on a dry run and sends nothing", async () => {
    const pl = await paperless();
    const res = await runScript(
      [
        "paperless",
        "--paperless-url",
        pl.url,
        "--tag",
        "HealthLog",
        "--dry-run",
      ],
      { PAPERLESS_TOKEN: "pl_test" },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(
      /2 document\(s\) would be imported, about 2\.0 MB/,
    );
    expect(pl.seen.some((s) => s.path.includes("/download/"))).toBe(false);
  });

  it("refuses to start without a HealthLog token", async () => {
    const res = await runScript(
      [
        "paperless",
        "--paperless-url",
        "http://x",
        "--healthlog-url",
        "http://y",
      ],
      { PAPERLESS_TOKEN: "pl_test" },
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/HEALTHLOG_TOKEN is not set/);
  });

  it("names a missing tag instead of importing everything", async () => {
    const pl = await paperless();
    const res = await runScript(
      ["paperless", "--paperless-url", pl.url, "--tag", "Nope", "--dry-run"],
      { PAPERLESS_TOKEN: "pl_test" },
    );
    expect(res.code).toBe(1);
  });
});

describe("import-documents.mjs — edges", () => {
  const env = { HEALTHLOG_TOKEN: "hlk_test", PAPERLESS_TOKEN: "pl_test" };

  it("still imports against a HealthLog without the lookup", async () => {
    const hl = await healthlog({ noLookup: true });
    const pl = await paperless();
    const res = await runScript(
      [
        "paperless",
        "--paperless-url",
        pl.url,
        "--healthlog-url",
        hl.url,
        "--tag",
        "HealthLog",
      ],
      env,
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Imported: 2/);
  });

  it("stops on a redirecting HealthLog address and names where it points", async () => {
    const hl = await healthlog({ redirect: "https://health.example" });
    const pl = await paperless();
    const res = await runScript(
      [
        "paperless",
        "--paperless-url",
        pl.url,
        "--healthlog-url",
        hl.url,
        "--tag",
        "HealthLog",
      ],
      env,
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/redirects to https:\/\/health\.example/);
  });

  it("applies --since itself when the server ignores the filter", async () => {
    const hl = await healthlog();
    const pl = await paperless();
    const res = await runScript(
      [
        "paperless",
        "--paperless-url",
        pl.url,
        "--healthlog-url",
        hl.url,
        "--tag",
        "HealthLog",
        "--since",
        "2024-04-01",
      ],
      env,
    );
    expect(res.code).toBe(0);
    // Document 1 (created 2024-03-05) is before the cut and never fetched.
    expect(hl.received.map((r) => r.fields.sourceId)).toEqual(["2"]);
    expect(pl.seen.some((s) => s.path.startsWith("/api/documents/1/"))).toBe(
      false,
    );
  });
});

describe("import-documents.mjs — Papra", () => {
  it("imports by tag since a date, and skips what HealthLog refuses as too large", async () => {
    const hl = await healthlog({ tooLarge: ["PAPRA:doc_b"] });
    const pp = await papra();
    const res = await runScript(
      [
        "papra",
        "--papra-url",
        pp.url,
        "--papra-org",
        "org_1",
        "--healthlog-url",
        hl.url,
        "--tag",
        "Health",
        "--since",
        "2016-01-01",
        "--kind-map",
        "Lab=LAB_RESULT",
        "--ai-read",
      ],
      { HEALTHLOG_TOKEN: "hlk_test", PAPRA_TOKEN: "pp_test" },
    );

    // Exit 3: finished, with at least one document skipped.
    expect(res.code).toBe(3);
    const sent = hl.received.map((r) => r.fields);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      title: "Impfpass",
      documentDate: "2019-06-01",
      sourceSystem: "PAPRA",
      sourceId: "doc_a",
    });
    // --ai-read: no deferral field at all.
    expect(sent[0].aiRead).toBeUndefined();
    expect(sent[1]).toMatchObject({ sourceId: "doc_b", kind: "LAB_RESULT" });
    // doc_old is before --since and never downloaded.
    expect(pp.seen.some((s) => s.path.includes("doc_old"))).toBe(false);
    expect(pp.seen.find((s) => s.path.includes("/documents?"))?.path).toContain(
      "searchQuery=tag%3AHealth",
    );
    expect(pp.seen[0].auth).toBe("Bearer pp_test");
    expect(res.stdout).toMatch(/Imported: 1/);
    expect(res.stdout).toMatch(/Skipped: 1/);
    expect(res.stdout).toMatch(/larger than HealthLog accepts/);
  });
});

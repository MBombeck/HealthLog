/**
 * Parity for `POST` and `GET /api/documents/inbound` while the upload
 * request handling and the list read move into `src/lib/documents/`.
 *
 * The upload walk: a stored PDF with metadata and an episode link, the same
 * bytes again, each refusal the route tells apart (no file, invalid
 * metadata, an empty file, an unsupported type, an unknown episode, half a
 * source key, a query and a form key that disagree), a narrow
 * `documents:write` token storing under a source key with AI reading held
 * back, its re-send by query key, its re-send after the person deleted the
 * document, and the module switched off. The list walk: the default page,
 * a search, the filters, a sorted page and the page after it, a refused
 * query, and a delegate reading the record. After each request the snapshot
 * holds the response, the wide event, the recorded queue tails and, for the
 * uploads, the stored documents.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/documents/inbound/route";
import { DOCUMENTS_WRITE_SCOPE } from "@/lib/documents/scopes";

import { callRoute, type RouteAuth } from "../../../kit/call-route";
import {
  makeGrant,
  makeSession,
  makeToken,
  makeUser,
} from "../../../kit/factories";
import {
  effectRecorder,
  eventFacts,
  expectParity,
  stable,
  wideEventRecorder,
} from "../../../kit/parity";
import {
  getPrismaClient,
  switchSessionTo,
  truncateAllTables,
} from "../../setup";

vi.mock("@/lib/logging/transports", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/logging/transports")>();
  const { wideEventRecorder: recorder } = await import("../../../kit/parity");
  return {
    ...actual,
    emitIfSampled: (event: (typeof recorder.events)[number]) => {
      recorder.events.push(event);
    },
  };
});
vi.mock("@/lib/jobs/document-index", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/jobs/document-index")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    enqueueDocumentIndex: async (...args: unknown[]) => {
      effectRecorder.record("enqueueDocumentIndex", args);
    },
  };
});
vi.mock("@/lib/jobs/document-thumbnail", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/jobs/document-thumbnail")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    enqueueDocumentThumbnail: async (...args: unknown[]) => {
      effectRecorder.record("enqueueDocumentThumbnail", args);
    },
  };
});
vi.mock("@/lib/jobs/document-summary", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/jobs/document-summary")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    enqueueDocumentSummary: async (...args: unknown[]) => {
      effectRecorder.record("enqueueDocumentSummary", args);
    },
  };
});

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");
const PDF = (tag: string) =>
  Buffer.from(`%PDF-1.7\n% ${tag}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`);

let userId: string;
let owner: RouteAuth;
let writer: RouteAuth;
let delegate: RouteAuth & { sessionId: string };
let episodeId: string;

async function stored() {
  return prisma.inboundDocument.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { filename: "asc" }],
    select: {
      id: true,
      kind: true,
      title: true,
      filename: true,
      mimeType: true,
      byteSize: true,
      status: true,
      documentDate: true,
      sourceSystem: true,
      sourceId: true,
      deletedAt: true,
      conditionLinks: { select: { episodeId: true } },
    },
  });
}

function form(
  file: Buffer | null,
  name: string,
  fields: Record<string, string | string[]> = {},
): FormData {
  const data = new FormData();
  if (file) data.set("file", new File([new Uint8Array(file)], name));
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      data.append(key, v);
    }
  }
  return data;
}

async function upload(
  name: string,
  body: FormData,
  options: { auth?: RouteAuth; query?: Record<string, string> } = {},
): Promise<{ id: string | null }> {
  wideEventRecorder.take();
  effectRecorder.take();
  const res = await callRoute<{ id: string | null }>(POST, {
    method: "POST",
    route: "/api/documents/inbound",
    body,
    query: options.query,
    auth: options.auth ?? owner,
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  await expectParity(
    `documents-inbound.${name}`,
    stable(
      {
        status: res.status,
        body: res.body,
        events: events.map(eventFacts),
        effects: effectRecorder.take(),
        stored: await stored(),
      },
      { since: NOW },
    ),
  );
  return { id: res.data?.id ?? null };
}

async function list(
  name: string,
  query: Record<string, string | number>,
  auth: RouteAuth = owner,
): Promise<{ nextCursor: string | null }> {
  wideEventRecorder.take();
  const res = await callRoute<{ nextCursor: string | null }>(GET, {
    method: "GET",
    route: "/api/documents/inbound",
    query,
    auth,
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  await expectParity(
    `documents-inbound.${name}`,
    stable(
      { status: res.status, body: res.body, events: events.map(eventFacts) },
      { since: NOW },
    ),
  );
  return { nextCursor: res.data?.nextCursor ?? null };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({
    timezone: "Europe/Berlin",
    modulePreferencesJson: { inboundDocuments: true },
  });
  userId = user.id;
  owner = await makeSession(user);
  writer = await makeToken(user, { permissions: [DOCUMENTS_WRITE_SCOPE] });
  const episode = await prisma.illnessEpisode.create({
    data: {
      userId,
      label: "Knee",
      type: "OTHER",
      onsetAt: new Date("2026-09-01T00:00:00.000Z"),
    },
  });
  episodeId = episode.id;
  const reader = await makeUser({ timezone: "UTC" });
  await makeGrant(user, reader);
  delegate = await makeSession(reader);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("POST /api/documents/inbound parity", () => {
  it("a stored upload and the same bytes again", async () => {
    const body = () =>
      form(PDF("discharge"), "discharge.pdf", {
        title: "Discharge letter",
        kind: "DISCHARGE_LETTER",
        documentDate: "2026-10-02",
        episodeIds: [episodeId],
      });
    await upload("post-01-stored", body());
    await upload("post-02-duplicate", body());
    await upload(
      "post-03-second",
      form(PDF("labs"), "labs.pdf", {
        title: "Blood test",
        kind: "LAB_RESULT",
        documentDate: "2025-03-04",
      }),
    );
  });

  it("the refusals", async () => {
    await upload("post-04-no-file", form(null, "x", { title: "Nothing" }));
    await upload(
      "post-05-invalid-metadata",
      form(PDF("bad-kind"), "bad.pdf", { kind: "SHOPPING_LIST" }),
    );
    await upload("post-06-empty", form(Buffer.alloc(0), "empty.pdf"));
    await upload(
      "post-07-unsupported",
      form(
        Buffer.from("<!doctype html><html><body>hi</body></html>\n"),
        "page.html",
      ),
    );
    await upload(
      "post-08-unknown-episode",
      form(PDF("orphan"), "orphan.pdf", {
        episodeIds: ["cmissingepisode000000000"],
      }),
    );
    await upload("post-09-half-key", form(PDF("half"), "half.pdf"), {
      query: { sourceSystem: "PAPERLESS" },
    });
    await upload(
      "post-10-keys-differ",
      form(PDF("differ"), "differ.pdf", {
        sourceSystem: "PAPERLESS",
        sourceId: "77",
      }),
      { query: { sourceSystem: "PAPERLESS", sourceId: "78" } },
    );
  });

  it("a narrow token storing under a source key", async () => {
    const stored = await upload(
      "post-11-token-stored",
      form(PDF("imported"), "imported.pdf", {
        sourceSystem: "PAPERLESS",
        sourceId: "41",
        aiRead: "defer",
      }),
      { auth: writer },
    );
    await upload("post-12-token-query-key", form(PDF("imported"), "x.pdf"), {
      auth: writer,
      query: { sourceSystem: "PAPERLESS", sourceId: "41" },
    });
    await prisma.inboundDocument.update({
      where: { id: stored.id! },
      data: { deletedAt: new Date("2026-10-14T09:00:00.000Z") },
    });
    await upload(
      "post-13-token-deleted",
      form(PDF("imported"), "imported.pdf", {
        sourceSystem: "PAPERLESS",
        sourceId: "41",
      }),
      { auth: writer },
    );
  });

  it("the module switched off", async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { modulePreferencesJson: { inboundDocuments: false } },
    });
    await upload("post-14-module-off", form(PDF("dark"), "dark.pdf"));
    await prisma.user.update({
      where: { id: userId },
      data: { modulePreferencesJson: { inboundDocuments: true } },
    });
  });
});

describe("GET /api/documents/inbound parity", () => {
  it("the default page, a search and the filters", async () => {
    await list("get-01-default", {});
    await list("get-02-search", { q: "blood" });
    await list("get-03-kind", { kind: "DISCHARGE_LETTER,LAB_RESULT" });
    await list("get-04-episode", { episodeId });
    await list("get-05-year", { year: 2025 });
    await list("get-06-range", { from: "2026-10-01", to: "2026-10-02" });
  });

  it("a sorted page and the page after it", async () => {
    const first = await list("get-07-sorted", {
      sort: "title",
      order: "asc",
      limit: 1,
    });
    await list("get-08-next-page", {
      sort: "title",
      order: "asc",
      limit: 1,
      cursor: first.nextCursor!,
    });
  });

  it("a refused query, and a delegate reading the record", async () => {
    await list("get-09-invalid", { sort: "size" });
    await switchSessionTo(delegate.sessionId, userId);
    await list("get-10-delegated", {}, delegate);
    await switchSessionTo(delegate.sessionId, null);
  });
});

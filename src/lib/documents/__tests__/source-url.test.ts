/**
 * #1394 — the link from an imported copy back to its original in the owner's
 * connected Paperless-ngx or Papra, and the owner-only gate around it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listConnections = vi.hoisted(() => vi.fn());
vi.mock("@/lib/documents/sources/connections", () => ({
  listConnections: (...a: unknown[]) => listConnections(...a),
}));

import {
  attachOwnerSourceUrls,
  buildSourceUrl,
  type SourceKeyFields,
  type SourceLinkConnection,
} from "../source-url";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";

const ORIGINS = new Set([
  "https://paperless.example.com",
  "http://papra.lan:1221",
]);
const ORG = "org_abcdefghijklmnopqrstuvwx";

const PAPERLESS: SourceLinkConnection = {
  system: "PAPERLESS",
  baseUrl: "https://paperless.example.com",
  organizationId: null,
};
const PAPRA: SourceLinkConnection = {
  system: "PAPRA",
  baseUrl: "http://papra.lan:1221",
  organizationId: ORG,
};

function key(
  sourceSystem: string | null,
  sourceId: string | null,
  sourceInstance: string | null = null,
): SourceKeyFields {
  return { sourceSystem, sourceId, sourceInstance };
}

describe("buildSourceUrl", () => {
  it("links a Paperless-ngx document to its details page", () => {
    expect(
      buildSourceUrl(key("PAPERLESS", "123"), [PAPERLESS, PAPRA], ORIGINS),
    ).toBe("https://paperless.example.com/documents/123/details");
  });

  it("links a Papra document under the connection's organization", () => {
    expect(
      buildSourceUrl(key("PAPRA", "doc_A-1"), [PAPERLESS, PAPRA], ORIGINS),
    ).toBe(`http://papra.lan:1221/organizations/${ORG}/documents/doc_A-1`);
  });

  it("keeps a base path, with or without a trailing slash", () => {
    for (const baseUrl of [
      "https://paperless.example.com/paperless",
      "https://paperless.example.com/paperless/",
    ]) {
      expect(
        buildSourceUrl(
          key("PAPERLESS", "7"),
          [{ ...PAPERLESS, baseUrl }],
          ORIGINS,
        ),
      ).toBe("https://paperless.example.com/paperless/documents/7/details");
    }
  });

  it("accepts a stored instance that is the connection's origin", () => {
    expect(
      buildSourceUrl(
        key("PAPERLESS", "5", "https://paperless.example.com"),
        [PAPERLESS],
        ORIGINS,
      ),
    ).toBe("https://paperless.example.com/documents/5/details");
  });

  it.each<[string, SourceKeyFields, SourceLinkConnection[]]>([
    ["a document without a source key", key(null, null), [PAPERLESS]],
    ["an OTHER import", key("OTHER", "123"), [PAPERLESS]],
    ["no connection for the system", key("PAPRA", "abc"), [PAPERLESS]],
    ["no connection at all", key("PAPERLESS", "123"), []],
    [
      "a Paperless id that is not digits",
      key("PAPERLESS", "12/../x"),
      [PAPERLESS],
    ],
    ["a Papra id with a slash", key("PAPRA", "a/b"), [PAPRA]],
    ["a dot-dot id", key("PAPRA", ".."), [PAPRA]],
    [
      "a stored instance on another origin",
      key("PAPERLESS", "1", "https://evil.example.com"),
      [PAPERLESS],
    ],
    [
      "a malformed stored instance",
      key("PAPERLESS", "1", "not a url"),
      [PAPERLESS],
    ],
    [
      "a malformed base URL",
      key("PAPERLESS", "1"),
      [{ ...PAPERLESS, baseUrl: "paperless.example.com" }],
    ],
    [
      "a base URL with a non-web scheme",
      key("PAPERLESS", "1"),
      [{ ...PAPERLESS, baseUrl: "javascript:alert(1)" }],
    ],
    [
      "a base URL the operator no longer lists",
      key("PAPERLESS", "1"),
      [{ ...PAPERLESS, baseUrl: "https://old-paperless.example.com" }],
    ],
    [
      "a Papra connection without an organization",
      key("PAPRA", "abc"),
      [{ ...PAPRA, organizationId: null }],
    ],
    [
      "a Papra organization of the wrong shape",
      key("PAPRA", "abc"),
      [{ ...PAPRA, organizationId: "../admin" }],
    ],
  ])("gives null for %s", (_label, doc, connections) => {
    expect(buildSourceUrl(doc, connections, ORIGINS)).toBeNull();
  });
});

function dto(id: string): InboundDocumentDto {
  return { id, sourceUrl: null } as InboundDocumentDto;
}

describe("attachOwnerSourceUrls", () => {
  const OWNER = { user: { id: "u1" }, actor: { id: "u1" }, grantId: null };

  beforeEach(() => {
    listConnections.mockReset();
    listConnections.mockResolvedValue([PAPERLESS, PAPRA]);
    vi.stubEnv(
      "DOCUMENT_SOURCE_ORIGINS",
      "https://paperless.example.com,http://papra.lan:1221",
    );
  });

  it("fills the link for the owner, from the owner's own connections", async () => {
    const a = dto("a");
    const b = dto("b");
    const c = dto("c");
    await attachOwnerSourceUrls(OWNER, [
      { dto: a, row: key("PAPERLESS", "9") },
      { dto: b, row: key("PAPRA", "x1") },
      { dto: c, row: key(null, null) },
    ]);
    expect(listConnections).toHaveBeenCalledWith("u1");
    expect(a.sourceUrl).toBe(
      "https://paperless.example.com/documents/9/details",
    );
    expect(b.sourceUrl).toBe(
      `http://papra.lan:1221/organizations/${ORG}/documents/x1`,
    );
    expect(c.sourceUrl).toBeNull();
  });

  it.each([
    [
      "a delegate under a grant",
      { ...OWNER, actor: { id: "d1" }, grantId: "g1" },
    ],
    [
      "a guardian on a managed profile",
      { ...OWNER, actor: { id: "g" }, grantId: "g2" },
    ],
    ["a grant without a switched actor", { ...OWNER, grantId: "g3" }],
    ["an actor other than the record", { ...OWNER, actor: { id: "x" } }],
  ])("leaves null for %s and reads no connection", async (_label, caller) => {
    const a = dto("a");
    await attachOwnerSourceUrls(caller, [
      { dto: a, row: key("PAPERLESS", "9") },
    ]);
    expect(a.sourceUrl).toBeNull();
    expect(listConnections).not.toHaveBeenCalled();
  });

  it("reads no connection when nothing on the page was imported from an archive", async () => {
    await attachOwnerSourceUrls(OWNER, [
      { dto: dto("a"), row: key(null, null) },
      { dto: dto("b"), row: key("OTHER", "1") },
    ]);
    expect(listConnections).not.toHaveBeenCalled();
  });

  it("reads no connection when the operator allows no archive", async () => {
    vi.stubEnv("DOCUMENT_SOURCE_ORIGINS", "");
    const a = dto("a");
    await attachOwnerSourceUrls(OWNER, [
      { dto: a, row: key("PAPERLESS", "9") },
    ]);
    expect(a.sourceUrl).toBeNull();
    expect(listConnections).not.toHaveBeenCalled();
  });
});

describe("MCP never carries the archive link", () => {
  it("no MCP module reads sourceUrl or the link builder", () => {
    const root = join(__dirname, "../../mcp");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (/\.(ts|snap)$/.test(name)) {
          const text = readFileSync(path, "utf8");
          if (/sourceUrl|source-url/.test(text)) offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders.length).toBe(0);
    // The walk saw the MCP tree, so an empty result means something.
    expect(readdirSync(root).length).toBeGreaterThan(0);
  });
});

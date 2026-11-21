/**
 * The scheduled Health Connect fetch against a real WebDAV-shaped server on
 * loopback (granted through HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS) and a real
 * Postgres: the settings route seals the credentials, a pass downloads the
 * file with Basic auth and hands it to the Health Connect queue once, an
 * unchanged file (304, or the same bytes) is not handed over again, and a
 * missing file backs off.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

const sent = vi.hoisted(() => [] as Array<{ queue: string; data: unknown }>);
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({
    send: vi.fn(async (queue: string, data: unknown) => {
      sent.push({ queue, data });
      return `boss-${sent.length}`;
    }),
  }),
}));

let server: Server;
let origin = "";
const requests: IncomingMessage[] = [];
let fileBody = Buffer.from("PK-synthetic-export-1");
let fileStatus = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req);
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from("me:app-pass").toString("base64")}`
    ) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (fileStatus !== 200) {
      res.writeHead(fileStatus);
      res.end();
      return;
    }
    const etag = `"${fileBody.length}-${fileBody[fileBody.length - 1]}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, { etag, "content-length": String(fileBody.length) });
    res.end(fileBody);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let userId = "";
beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  sent.length = 0;
  requests.length = 0;
  fileBody = Buffer.from("PK-synthetic-export-1");
  fileStatus = 200;
  process.env.HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS = origin;
  const user = await prisma.user.create({
    data: {
      username: `hcr-${Date.now()}`,
      email: `hcr-${Date.now()}@example.test`,
      timezone: "UTC",
    },
  });
  userId = user.id;
  const session = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

async function save(body: unknown) {
  const { PUT } = await import("@/app/api/import/health-connect-remote/route");
  const res = await (PUT as unknown as (r: NextRequest) => Promise<Response>)(
    new NextRequest("http://localhost/api/import/health-connect-remote", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

async function pass() {
  const { fetchRemoteSourceNow } =
    await import("@/lib/import/health-connect/remote-fetch");
  return fetchRemoteSourceNow(userId);
}

describe("scheduled Health Connect fetch", () => {
  it("seals the credentials and imports a new file exactly once", async () => {
    const saved = await save({
      folderUrl: `${origin}/remote.php/dav/files/me/Health`,
      username: "me",
      password: "app-pass",
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain("app-pass");
    const row =
      await getPrismaClient().healthConnectRemoteSource.findUniqueOrThrow({
        where: { userId },
      });
    expect(row.credentialsEncrypted).not.toContain("app-pass");

    expect(await pass()).toBe("imported");
    expect(requests.at(-1)?.url).toBe(
      "/remote.php/dav/files/me/Health/Health%20Connect.zip",
    );
    expect(sent.map((s) => s.queue)).toEqual(["health-connect-import"]);
    const job = await getPrismaClient().importJob.findFirstOrThrow({
      where: { userId, kind: "health_connect" },
    });
    expect(job.uploadBytes).toBe(fileBody.length);

    // The server answers 304 for the ETag it sent.
    expect(await pass()).toBe("unchanged");
    expect(sent).toHaveLength(1);

    // The same bytes under a new ETag are still not handed over twice.
    await getPrismaClient().healthConnectRemoteSource.update({
      where: { userId },
      data: { lastEtag: null },
    });
    expect(await pass()).toBe("unchanged");
    expect(sent).toHaveLength(1);
  });

  it("refuses a private folder that is not granted", async () => {
    delete process.env.HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS;
    const saved = await save({
      folderUrl: `${origin}/dav`,
      username: "me",
      password: "app-pass",
    });
    expect(saved.status).toBe(422);
    expect(saved.body.meta?.errorCode).toBe(
      "import.health_connect.remote.private_origin_not_approved",
    );
  });

  it("backs off when the file is missing or the password is wrong", async () => {
    await save({
      folderUrl: `${origin}/dav`,
      username: "me",
      password: "wrong",
    });
    expect(await pass()).toBe("unauthorized");
    fileStatus = 404;
    await save({
      folderUrl: `${origin}/dav`,
      username: "me",
      password: "app-pass",
    });
    expect(await pass()).toBe("not_found");
    const row =
      await getPrismaClient().healthConnectRemoteSource.findUniqueOrThrow({
        where: { userId },
      });
    // New credentials reset the backoff; the missing file starts it again.
    expect(row.consecutiveFailures).toBe(1);
    expect(row.lastOutcome).toBe("not_found");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(
      Date.now() + 20 * 60_000,
    );
    expect(sent).toHaveLength(0);
  });
});

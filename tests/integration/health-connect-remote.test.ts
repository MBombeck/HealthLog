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
/** The server sends part of the file and hangs up. */
let hangUpMidStream = false;
/** The password the test server accepts. */
const ACCEPTED_PASSWORD = "app-pass";

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
    if (hangUpMidStream) {
      res.writeHead(200, { etag, "content-length": String(1024 * 1024) });
      res.write(fileBody, () => res.socket?.destroy());
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
  hangUpMidStream = false;
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

  it("fetches the same file again when its import failed, unless the file was refused", async () => {
    await save({
      folderUrl: `${origin}/remote.php/dav/files/me/Health`,
      username: "me",
      password: "app-pass",
    });
    expect(await pass()).toBe("imported");
    const prisma = getPrismaClient();
    const failJob = (failureReason: string) =>
      prisma.importJob.updateMany({
        where: { userId, kind: "health_connect" },
        data: { status: "failed", failureReason, completedAt: new Date() },
      });

    // The import stopped on the server's side: the same file is due again.
    await failJob(
      "staging_missing: the uploaded file is no longer on the server.",
    );
    expect(await pass()).toBe("imported");
    expect(sent).toHaveLength(2);
    expect(requests.at(-1)?.headers["if-none-match"]).toBeUndefined();

    // A file the importer refused is not fetched again until it changes.
    await failJob(
      "not_health_connect: the archive holds no Health Connect database",
    );
    expect(await pass()).toBe("unchanged");
    expect(sent).toHaveLength(2);
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

  it("stamps a download the server cut off mid-stream, and backs off", async () => {
    await save({
      folderUrl: `${origin}/dav`,
      username: "me",
      password: ACCEPTED_PASSWORD,
    });
    hangUpMidStream = true;
    expect(await pass()).toBe("network");
    const row =
      await getPrismaClient().healthConnectRemoteSource.findUniqueOrThrow({
        where: { userId },
      });
    expect(row.lastOutcome).toBe("network");
    expect(row.consecutiveFailures).toBe(1);
    expect(row.lastAttemptAt).not.toBeNull();
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(
      Date.now() + 20 * 60_000,
    );
    expect(sent).toHaveLength(0);
  });

  it("writes every fetch to the shared ledger the integrations envelope reads", async () => {
    const { GET: status } = await import("@/app/api/integrations/status/route");
    const { DELETE } =
      await import("@/app/api/import/health-connect-remote/route");
    const entry = async () => {
      const res = await (status as unknown as () => Promise<Response>)();
      const body = (await res.json()) as {
        data: {
          integrations: Array<{
            integration: string;
            state: string;
            connected: boolean;
            configured: boolean;
            health: { state: string; action?: string | null } | null;
          }>;
        };
      };
      const list = body.data.integrations;
      expect(list.at(-1)?.integration).toBe("health-connect-remote");
      return list.find((e) => e.integration === "health-connect-remote")!;
    };
    const ledger = () =>
      getPrismaClient().integrationStatus.findUnique({
        where: {
          userId_integration: { userId, integration: "health-connect-remote" },
        },
      });

    const before = await entry();
    expect(before.configured).toBe(false);
    expect(before.health).toBeNull();

    // A refused password parks the connection at reauth, not at a retry.
    await save({
      folderUrl: `${origin}/dav`,
      username: "me",
      password: "wrong",
    });
    expect(await pass()).toBe("unauthorized");
    expect((await ledger())?.state).toBe("error_reauth");
    const refused = await entry();
    expect(refused.connected).toBe(true);
    expect(refused.health?.state).toBe("action_required");

    // A new password starts a fresh streak; the next fetch is a success.
    await save({
      folderUrl: `${origin}/dav`,
      username: "me",
      password: ACCEPTED_PASSWORD,
    });
    expect((await ledger())?.state).toBe("connected");
    expect(await pass()).toBe("imported");
    const fine = await ledger();
    expect(fine?.state).toBe("connected");
    expect(fine?.lastSuccessAt).not.toBeNull();

    // A missing file is a persistent failure, retried on the next pass.
    fileStatus = 404;
    await getPrismaClient().healthConnectRemoteSource.update({
      where: { userId },
      data: { lastEtag: null, nextAttemptAt: new Date() },
    });
    expect(await pass()).toBe("not_found");
    expect((await ledger())?.state).toBe("error_transient");

    // Forgetting the folder closes the connection on the ledger as well.
    await (DELETE as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/import/health-connect-remote", {
        method: "DELETE",
      }),
    );
    expect((await ledger())?.state).toBe("disconnected");
    const gone = await entry();
    expect(gone.configured).toBe(false);
  });
});

describe("where the stored password may go", () => {
  const PASSWORD = ["app", "pass"].join("-");

  async function stored() {
    return getPrismaClient().healthConnectRemoteSource.findUniqueOrThrow({
      where: { userId },
    });
  }

  it("refuses a move to another server without a new password, and keeps the row", async () => {
    await save({
      folderUrl: `${origin}/dav`,
      username: "me",
      password: PASSWORD,
    });
    const before = await stored();
    const moved = await save({
      folderUrl: "https://cloud.example.com/remote.php/dav/files/me",
      username: "me",
    });
    expect(moved.status).toBe(422);
    expect(moved.body.meta?.errorCode).toBe(
      "import.health_connect.remote.password_required",
    );
    const after = await stored();
    expect(after.folderUrl).toBe(before.folderUrl);
    expect(after.credentialsEncrypted).toBe(before.credentialsEncrypted);

    // With a password of its own the move is saved, and the old one is gone.
    const withPassword = await save({
      folderUrl: "https://cloud.example.com/remote.php/dav/files/me",
      username: "me",
      password: "another-one",
    });
    expect(withPassword.status).toBe(200);
    const replaced = await stored();
    expect(replaced.folderUrl).toBe(
      "https://cloud.example.com/remote.php/dav/files/me",
    );
    expect(replaced.credentialsEncrypted).not.toBe(before.credentialsEncrypted);
  });

  it("keeps the password for another folder on the same server", async () => {
    await save({
      folderUrl: `${origin}/dav`,
      username: "me",
      password: PASSWORD,
    });
    const before = await stored();
    const res = await save({
      folderUrl: `${origin}/dav/elsewhere`,
      username: "me",
    });
    expect(res.status).toBe(200);
    const after = await stored();
    expect(after.folderUrl).toBe(`${origin}/dav/elsewhere`);
    expect(after.credentialsEncrypted).toBe(before.credentialsEncrypted);
    expect(await pass()).toBe("imported");
  });

  it("asks for a fresh proof before it writes a password", async () => {
    await save({
      folderUrl: `${origin}/dav`,
      username: "me",
      password: PASSWORD,
    });
    await getPrismaClient().session.updateMany({
      where: { userId },
      data: { createdAt: new Date(Date.now() - 60 * 60_000) },
    });
    const before = await stored();
    const refused = await save({
      folderUrl: `${origin}/dav`,
      username: "me",
      password: "another-one",
    });
    expect(refused.status).toBe(401);
    expect(refused.body.meta?.errorCode).toBe("auth.reproof.required");
    expect((await stored()).credentialsEncrypted).toBe(
      before.credentialsEncrypted,
    );
    // A save that writes no password (the switch, the file name) needs none.
    const toggled = await save({
      folderUrl: `${origin}/dav`,
      username: "me",
      enabled: false,
    });
    expect(toggled.status).toBe(200);
    expect((await stored()).enabled).toBe(false);
  });

  it("refuses a public folder over plain http", async () => {
    const res = await save({
      folderUrl: "http://cloud.example.com/remote.php/dav/files/me",
      username: "me",
      password: PASSWORD,
    });
    expect(res.status).toBe(422);
    expect(res.body.meta?.errorCode).toBe(
      "import.health_connect.remote.https_required",
    );
  });
});

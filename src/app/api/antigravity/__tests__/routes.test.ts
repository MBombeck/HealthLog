import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/ai/antigravity-probe", () => ({
  probeCli: vi.fn(),
}));

vi.mock("@/lib/ai/antigravity-install", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/antigravity-install")>();
  return {
    ...actual,
    resolveAntigravityBinary: vi.fn(),
    isAntigravityBinaryManaged: vi.fn(),
    getLatestAntigravityRelease: vi.fn(),
    installAntigravityCli: vi.fn(),
  };
});

import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { probeCli } from "@/lib/ai/antigravity-probe";
import {
  resolveAntigravityBinary,
  isAntigravityBinaryManaged,
  getLatestAntigravityRelease,
  installAntigravityCli,
  type AntigravityReleaseInfo,
} from "@/lib/ai/antigravity-install";
import { GET as statusGET } from "../status/route";
import { POST as installPOST } from "../install/route";

const statusGETWithRequest = statusGET as unknown as (
  request: NextRequest,
) => Promise<Response>;
const installPOSTWithRequest = installPOST as unknown as (
  request: NextRequest,
) => Promise<Response>;

const ADMIN_SESSION = {
  session: { id: "sess-admin", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-admin", username: "admin", role: "ADMIN" as const },
};

const USER_SESSION = {
  session: { id: "sess-user", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-user", username: "member", role: "USER" as const },
};

const mockRelease: AntigravityReleaseInfo = {
  version: "1.5.11",
  tagName: "v1.5.11",
  assetName: "agy_cli_linux_x64.tar.gz",
  downloadUrl:
    "https://github.com/google-antigravity/antigravity-cli/releases/download/v1.5.11/agy_cli_linux_x64.tar.gz",
  sha256: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
};

function statusReq(): NextRequest {
  return new NextRequest("http://localhost/api/antigravity/status", {
    method: "GET",
  });
}

function installReq(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/antigravity/install", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    antigravityProfileId: "prof-1",
    antigravityConnectionStatus: "connected",
    antigravityConnectedAt: new Date("2026-11-01T10:00:00Z"),
    antigravityCapabilitiesJson: null,
  } as never);
});

describe("Admin Authorization Boundary", () => {
  it("refuses unauthenticated callers on GET /status and POST /install", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const statusRes = await statusGETWithRequest(statusReq());
    expect(statusRes.status).toBe(401);

    const installRes = await installPOSTWithRequest(installReq());
    expect(installRes.status).toBe(401);
  });

  it("refuses non-admin user on POST /install with 403", async () => {
    vi.mocked(getSession).mockResolvedValue(USER_SESSION as never);

    const res = await installPOSTWithRequest(installReq({ action: "update" }));
    expect(res.status).toBe(403);
  });

  it("denies canInstallCli and canUpdateCli to non-admin user in GET /status", async () => {
    vi.mocked(getSession).mockResolvedValue(USER_SESSION as never);
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/var/lib/healthlog/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(true);
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.5.10" });
    vi.mocked(getLatestAntigravityRelease).mockResolvedValue(mockRelease);

    const res = await statusGETWithRequest(statusReq());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        canInstallCli: boolean;
        canUpdateCli: boolean;
        updateAvailable: boolean;
        latestVersion: string | null;
      };
    };

    expect(body.data.canInstallCli).toBe(false);
    expect(body.data.canUpdateCli).toBe(false);
    expect(body.data.updateAvailable).toBe(true);
    expect(body.data.latestVersion).toBe("1.5.11");
  });
});

describe("GET /api/antigravity/status updater discovery", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION as never);
  });

  it("reports updateAvailable: true when installed version is older than GitHub release", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/var/lib/healthlog/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(true);
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.5.10" });
    vi.mocked(getLatestAntigravityRelease).mockResolvedValue(mockRelease);

    const res = await statusGETWithRequest(statusReq());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        canUpdateCli: boolean;
        updateAvailable: boolean;
        cliManaged: boolean;
        cliVersion: string;
        latestVersion: string | null;
      };
    };

    expect(body.data.cliVersion).toBe("1.5.10");
    expect(body.data.cliManaged).toBe(true);
    expect(body.data.updateAvailable).toBe(true);
    expect(body.data.canUpdateCli).toBe(true);
    expect(body.data.latestVersion).toBe("1.5.11");
  });

  it("reports updateAvailable: false when installed version is equal to GitHub release", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/var/lib/healthlog/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(true);
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.5.11" });
    vi.mocked(getLatestAntigravityRelease).mockResolvedValue(mockRelease);

    const res = await statusGETWithRequest(statusReq());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        canUpdateCli: boolean;
        updateAvailable: boolean;
        latestVersion: string | null;
      };
    };

    expect(body.data.updateAvailable).toBe(false);
    expect(body.data.canUpdateCli).toBe(false);
    expect(body.data.latestVersion).toBe("1.5.11");
  });

  it("reports updateAvailable: false when installed version is newer than GitHub release", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/var/lib/healthlog/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(true);
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.6.0" });
    vi.mocked(getLatestAntigravityRelease).mockResolvedValue(mockRelease);

    const res = await statusGETWithRequest(statusReq());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        canUpdateCli: boolean;
        updateAvailable: boolean;
        latestVersion: string | null;
      };
    };

    expect(body.data.updateAvailable).toBe(false);
    expect(body.data.canUpdateCli).toBe(false);
    expect(body.data.latestVersion).toBe("1.5.11");
  });

  it("reports updateAvailable: false and canUpdateCli: false when binary is externally managed", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/usr/local/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(false);
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.5.8" });
    vi.mocked(getLatestAntigravityRelease).mockResolvedValue(mockRelease);

    const res = await statusGETWithRequest(statusReq());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        cliManaged: boolean;
        canUpdateCli: boolean;
        updateAvailable: boolean;
        latestVersion: string | null;
      };
    };

    expect(body.data.cliManaged).toBe(false);
    expect(body.data.updateAvailable).toBe(false);
    expect(body.data.canUpdateCli).toBe(false);
    expect(body.data.latestVersion).toBe("1.5.11");
  });

  it("fails safely when GitHub release lookup fails during status polling", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/var/lib/healthlog/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(true);
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.5.10" });
    vi.mocked(getLatestAntigravityRelease).mockRejectedValue(
      new Error("GitHub releases API rate limit exceeded"),
    );

    const res = await statusGETWithRequest(statusReq());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        cliInstalled: boolean;
        updateAvailable: boolean;
        canUpdateCli: boolean;
        latestVersion: string | null;
      };
    };

    expect(body.data.cliInstalled).toBe(true);
    expect(body.data.updateAvailable).toBe(false);
    expect(body.data.canUpdateCli).toBe(false);
    expect(body.data.latestVersion).toBeNull();
  });

  it("reports latestVersion from GitHub release when CLI is not installed", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue(null);
    vi.mocked(getLatestAntigravityRelease).mockResolvedValue(mockRelease);

    const res = await statusGETWithRequest(statusReq());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        cliInstalled: boolean;
        latestVersion: string | null;
        updateAvailable: boolean;
        canUpdateCli: boolean;
      };
    };

    expect(body.data.cliInstalled).toBe(false);
    expect(body.data.latestVersion).toBe("1.5.11");
    expect(body.data.updateAvailable).toBe(false);
    expect(body.data.canUpdateCli).toBe(false);
  });
});

describe("POST /api/antigravity/install updater flow", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION as never);
  });

  it("refuses update when binary is not installed", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue(null);

    const res = await installPOSTWithRequest(installReq({ action: "update" }));
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Antigravity CLI is not installed");
  });

  it("refuses update when binary is externally managed", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/usr/local/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(false);

    const res = await installPOSTWithRequest(installReq({ action: "update" }));
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      "Antigravity CLI is externally managed and cannot be updated",
    );
  });

  it("refuses update when installed version equals GitHub release version", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/var/lib/healthlog/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(true);
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.5.11" });
    vi.mocked(getLatestAntigravityRelease).mockResolvedValue(mockRelease);

    const res = await installPOSTWithRequest(installReq({ action: "update" }));
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Antigravity CLI is already up to date");
    expect(installAntigravityCli).not.toHaveBeenCalled();
  });

  it("refuses update when installed version is newer than GitHub release version", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/var/lib/healthlog/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(true);
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.6.0" });
    vi.mocked(getLatestAntigravityRelease).mockResolvedValue(mockRelease);

    const res = await installPOSTWithRequest(installReq({ action: "update" }));
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      "Cannot downgrade Antigravity CLI from a newer version",
    );
    expect(installAntigravityCli).not.toHaveBeenCalled();
  });

  it("handles GitHub failure during update by returning 502 without touching binary", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/var/lib/healthlog/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(true);
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.5.10" });
    vi.mocked(getLatestAntigravityRelease).mockRejectedValue(
      new Error("GitHub releases API rate limit exceeded"),
    );

    const res = await installPOSTWithRequest(installReq({ action: "update" }));
    expect(res.status).toBe(502);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Failed to discover latest Antigravity CLI release");
    expect(installAntigravityCli).not.toHaveBeenCalled();
  });

  it("does not repair an existing binary from the pinned fallback during a GitHub outage", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/var/lib/healthlog/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(true);
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.5.11" });
    vi.mocked(getLatestAntigravityRelease).mockRejectedValue(
      new Error("GitHub releases API rate limit exceeded"),
    );

    const res = await installPOSTWithRequest(installReq({ force: true }));
    expect(res.status).toBe(502);
    expect(installAntigravityCli).not.toHaveBeenCalled();
  });

  it("refuses forced repair when the discovered release is older than the installed binary", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/var/lib/healthlog/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(true);
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.6.0" });
    vi.mocked(getLatestAntigravityRelease).mockResolvedValue(mockRelease);

    const res = await installPOSTWithRequest(installReq({ force: true }));
    expect(res.status).toBe(400);
    expect(installAntigravityCli).not.toHaveBeenCalled();
  });

  it("successfully updates when a newer release is discovered", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/var/lib/healthlog/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(true);
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.5.10" });
    vi.mocked(getLatestAntigravityRelease).mockResolvedValue(mockRelease);
    vi.mocked(installAntigravityCli).mockResolvedValue({
      version: "1.5.11",
      binaryPath: "/var/lib/healthlog/bin/agy",
      alreadyInstalled: false,
    });

    const res = await installPOSTWithRequest(installReq({ action: "update" }));
    expect(res.status).toBe(200);

    expect(getLatestAntigravityRelease).toHaveBeenCalledWith({ forceFresh: true });
    expect(installAntigravityCli).toHaveBeenCalledWith({
      force: true,
      release: mockRelease,
    });

    const body = (await res.json()) as {
      data: { version: string; binaryPath: string; alreadyInstalled: boolean };
    };
    expect(body.data.version).toBe("1.5.11");
    expect(body.data.alreadyInstalled).toBe(false);
  });
});

describe("POST /api/antigravity/install Content-Type and forced reinstall handling", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION as never);
  });

  it("rejects missing Content-Type header with 415", async () => {
    const req = new NextRequest("http://localhost/api/antigravity/install", {
      method: "POST",
      body: JSON.stringify({ action: "update" }),
    });

    const res = await installPOSTWithRequest(req);
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Content-Type must be application/json");
  });

  it("rejects non-JSON Content-Type with 415", async () => {
    const req = new NextRequest("http://localhost/api/antigravity/install", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "action=update",
    });

    const res = await installPOSTWithRequest(req);
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Content-Type must be application/json");
  });

  it("accepts a bodyless install request as the default install action", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/var/lib/healthlog/bin/agy");
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.5.11" });

    const req = new NextRequest("http://localhost/api/antigravity/install", {
      method: "POST",
    });
    const res = await installPOSTWithRequest(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { alreadyInstalled: boolean } };
    expect(body.data.alreadyInstalled).toBe(true);
  });

  it("allows forced reinstall of an already installed healthy managed binary", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/var/lib/healthlog/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(true);
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.5.11" });
    vi.mocked(getLatestAntigravityRelease).mockResolvedValue(mockRelease);
    vi.mocked(installAntigravityCli).mockResolvedValue({
      version: "1.5.11",
      binaryPath: "/var/lib/healthlog/bin/agy",
      alreadyInstalled: false,
    });

    const res = await installPOSTWithRequest(installReq({ force: true }));
    expect(res.status).toBe(200);
    expect(installAntigravityCli).toHaveBeenCalledWith({
      force: true,
      release: mockRelease,
    });
  });

  it("refuses forced reinstall when binary is externally managed", async () => {
    vi.mocked(resolveAntigravityBinary).mockReturnValue("/usr/local/bin/agy");
    vi.mocked(isAntigravityBinaryManaged).mockReturnValue(false);
    vi.mocked(probeCli).mockResolvedValue({ installed: true, version: "1.5.11" });

    const res = await installPOSTWithRequest(installReq({ force: true }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("externally managed and cannot be repaired");
    expect(installAntigravityCli).not.toHaveBeenCalled();
  });
});

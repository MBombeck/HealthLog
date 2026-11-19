import { describe, it, expect, vi, beforeEach } from "vitest";

const stateStore: Record<number, unknown> = {};
const refsStore: Record<number, { current: unknown }> = {};
let stateIdx = 0;
let refIdx = 0;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const idx = stateIdx++;
      if (!(idx in stateStore)) {
        stateStore[idx] = initial;
      }
      const setState = (next: unknown) => {
        stateStore[idx] =
          typeof next === "function"
            ? (next as (prev: unknown) => unknown)(stateStore[idx])
            : next;
      };
      return [stateStore[idx], setState];
    },
    useRef: (initial: unknown) => {
      const idx = refIdx++;
      if (!(idx in refsStore)) {
        refsStore[idx] = { current: initial };
      }
      return refsStore[idx];
    },
    useEffect: vi.fn(),
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === "settings.ai.antigravity.updateCliSuccess") {
        return "Antigravity CLI updated successfully.";
      }
      if (key === "settings.ai.antigravity.updateCliFailed") {
        return "Failed to update Antigravity CLI.";
      }
      if (key === "settings.ai.antigravity.installCliSuccess") {
        return "Antigravity CLI installed successfully.";
      }
      if (key === "settings.ai.antigravity.installCliFailed") {
        return "Failed to install Antigravity CLI.";
      }
      if (key === "settings.ai.antigravity.cliVersion") {
        return `Version ${params?.version}`;
      }
      if (key === "settings.ai.antigravity.reasonFailed") {
        return "The connection test failed. Try again, or ask the operator to check the server.";
      }
      return key;
    },
  }),
  useFormatters: () => ({
    dateTime: () => "2026-11-01 10:00",
  }),
}));

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiPut: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    meta?: Record<string, unknown>;
    constructor(
      message: string,
      status: number,
      meta?: Record<string, unknown>,
    ) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.meta = meta;
    }
  },
}));

vi.mock("@/components/outcome/outcome-toast", () => ({
  toastWrittenOutcome: vi.fn(),
}));

import { apiGet, apiPost, ApiError } from "@/lib/api/api-fetch";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { useAntigravityProfile } from "../use-antigravity-profile";
import { compareSemver } from "../shared";

describe("compareSemver helper", () => {
  it("compares semver strings correctly", () => {
    expect(compareSemver("1.5.10", "1.5.11")).toBe(-1);
    expect(compareSemver("1.5.11", "1.5.11")).toBe(0);
    expect(compareSemver("1.6.0", "1.5.11")).toBe(1);
    expect(compareSemver("v1.5.11", "1.5.11")).toBe(0);
    expect(compareSemver("1.5.11", "v1.5.10")).toBe(1);
  });
});

describe("useAntigravityProfile updater flow and guards", () => {
  function useTestProfile() {
    stateIdx = 0;
    refIdx = 0;
    return useAntigravityProfile();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(stateStore)) delete stateStore[Number(key)];
    for (const key of Object.keys(refsStore)) delete refsStore[Number(key)];
    stateIdx = 0;
    refIdx = 0;
    vi.mocked(apiGet).mockResolvedValue({
      cliInstalled: true,
      cliVersion: "1.5.10",
      canInstallCli: false,
      canUpdateCli: true,
      cliManaged: true,
      updateAvailable: true,
      latestVersion: "1.5.11",
      profileId: "prof-1",
      connectionStatus: "disconnected",
      connectedAt: null,
      capabilities: null,
    });
  });

  it("calls apiPost with { action: 'update' } and { signal: null } to avoid 15s timeout", async () => {
    const profile = useTestProfile();

    vi.mocked(apiPost).mockResolvedValueOnce({
      version: "1.5.11",
      binaryPath: "/var/lib/healthlog/bin/agy",
      alreadyInstalled: false,
    });

    await profile.updateCli();

    expect(apiPost).toHaveBeenCalledWith(
      "/api/antigravity/install",
      { action: "update" },
      { signal: null },
    );
  });

  it("shows localized success toast with installed version preferred", async () => {
    const profile = useTestProfile();

    vi.mocked(apiPost).mockResolvedValueOnce({
      version: "1.5.11",
      binaryPath: "/var/lib/healthlog/bin/agy",
      alreadyInstalled: false,
    });

    await profile.updateCli();

    expect(toastWrittenOutcome).toHaveBeenCalledWith(
      "success",
      "Antigravity CLI updated successfully. (Version 1.5.11)",
    );
  });

  it("guards against concurrent requests (single request guard)", async () => {
    const profile = useTestProfile();

    let resolveFirst: (value: unknown) => void = () => {};
    const deferred = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(apiPost).mockReturnValueOnce(
      deferred as ReturnType<typeof apiPost>,
    );

    // First click triggers in-flight request
    const p1 = profile.updateCli();

    // Second click during in-flight should be ignored immediately
    const p2 = profile.updateCli();

    expect(apiPost).toHaveBeenCalledTimes(1);

    resolveFirst({
      version: "1.5.11",
      binaryPath: "/var/lib/healthlog/bin/agy",
      alreadyInstalled: false,
    });

    await Promise.all([p1, p2]);

    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it("shows specific localized error toast and updates notice when update fails", async () => {
    const profile = useTestProfile();

    vi.mocked(apiPost).mockRejectedValueOnce(new ApiError("Server error", 500));

    await profile.updateCli();

    expect(toastWrittenOutcome).toHaveBeenCalledWith(
      "failed",
      "Failed to update Antigravity CLI.",
    );
    expect(useTestProfile().notice).toBe("Failed to update Antigravity CLI.");
  });

  it("resets busyRef and allows a successful call after an earlier failure", async () => {
    const profile = useTestProfile();

    vi.mocked(apiPost).mockRejectedValueOnce(new ApiError("Server error", 500));
    await profile.updateCli();
    expect(useTestProfile().notice).toBe("Failed to update Antigravity CLI.");

    vi.mocked(apiPost).mockResolvedValueOnce({
      version: "1.5.11",
      binaryPath: "/var/lib/healthlog/bin/agy",
      alreadyInstalled: false,
    });
    await profile.updateCli();

    expect(toastWrittenOutcome).toHaveBeenLastCalledWith(
      "success",
      "Antigravity CLI updated successfully. (Version 1.5.11)",
    );
  });

  it("server is authoritative after refresh while retaining safe in-flight ordering", async () => {
    const profile = useTestProfile();

    vi.mocked(apiPost).mockResolvedValueOnce({
      version: "1.5.11",
      binaryPath: "/var/lib/healthlog/bin/agy",
      alreadyInstalled: false,
    });
    // Server returns authoritative data matching updated installation
    vi.mocked(apiGet).mockResolvedValueOnce({
      cliInstalled: true,
      cliVersion: "1.5.11",
      canInstallCli: false,
      canUpdateCli: false,
      cliManaged: true,
      updateAvailable: false,
      latestVersion: "1.5.11",
      profileId: "prof-1",
      connectionStatus: "disconnected",
      connectedAt: null,
      capabilities: null,
    });

    await profile.updateCli();

    let updated = useTestProfile();
    expect(updated.status?.cliVersion).toBe("1.5.11");
    expect(updated.status?.canUpdateCli).toBe(false);
    expect(updated.status?.updateAvailable).toBe(false);

    // Subsequent refresh from server is authoritative and does not retain stale completed refs
    vi.mocked(apiGet).mockResolvedValueOnce({
      cliInstalled: true,
      cliVersion: "1.5.11",
      canInstallCli: false,
      canUpdateCli: true,
      cliManaged: true,
      updateAvailable: true,
      latestVersion: "1.5.12",
      profileId: "prof-1",
      connectionStatus: "disconnected",
      connectedAt: null,
      capabilities: null,
    });

    await profile.refresh();

    updated = useTestProfile();
    expect(updated.status?.cliVersion).toBe("1.5.11");
    expect(updated.status?.canUpdateCli).toBe(true);
    expect(updated.status?.updateAvailable).toBe(true);
    expect(updated.status?.latestVersion).toBe("1.5.12");
  });

  it("preserves operation result if immediate post-update status returns stale data, without masking later server state", async () => {
    const profile = useTestProfile();

    vi.mocked(apiPost).mockResolvedValueOnce({
      version: "1.5.11",
      binaryPath: "/var/lib/healthlog/bin/agy",
      alreadyInstalled: false,
    });
    // Immediate post-update status returns stale data (e.g. 1.5.10 with updateAvailable: true)
    vi.mocked(apiGet).mockResolvedValueOnce({
      cliInstalled: true,
      cliVersion: "1.5.10",
      canInstallCli: false,
      canUpdateCli: true,
      cliManaged: true,
      updateAvailable: true,
      latestVersion: "1.5.11",
      profileId: "prof-1",
      connectionStatus: "disconnected",
      connectedAt: null,
      capabilities: null,
    });

    await profile.updateCli();

    let updated = useTestProfile();
    // 1.5.11 is preserved despite immediate stale response from server
    expect(updated.status?.cliVersion).toBe("1.5.11");
    expect(updated.status?.canUpdateCli).toBe(false);
    expect(updated.status?.updateAvailable).toBe(false);

    // Later refresh returns the actual server state (caught up to 1.5.11)
    vi.mocked(apiGet).mockResolvedValueOnce({
      cliInstalled: true,
      cliVersion: "1.5.11",
      canInstallCli: false,
      canUpdateCli: false,
      cliManaged: true,
      updateAvailable: false,
      latestVersion: "1.5.11",
      profileId: "prof-1",
      connectionStatus: "disconnected",
      connectedAt: null,
      capabilities: null,
    });

    await profile.refresh();

    updated = useTestProfile();
    expect(updated.status?.cliVersion).toBe("1.5.11");
    expect(updated.status?.canUpdateCli).toBe(false);
    expect(updated.status?.updateAvailable).toBe(false);

    // Future update (1.5.12) is NOT masked
    vi.mocked(apiGet).mockResolvedValueOnce({
      cliInstalled: true,
      cliVersion: "1.5.11",
      canInstallCli: false,
      canUpdateCli: true,
      cliManaged: true,
      updateAvailable: true,
      latestVersion: "1.5.12",
      profileId: "prof-1",
      connectionStatus: "disconnected",
      connectedAt: null,
      capabilities: null,
    });

    await profile.refresh();

    updated = useTestProfile();
    expect(updated.status?.cliVersion).toBe("1.5.11");
    expect(updated.status?.canUpdateCli).toBe(true);
    expect(updated.status?.updateAvailable).toBe(true);
    expect(updated.status?.latestVersion).toBe("1.5.12");
  });

  it("retains optimistic version and shows localized refresh failure if refresh fails after update", async () => {
    const profile = useTestProfile();
    stateStore[0] = {
      cliInstalled: true,
      cliVersion: "1.5.10",
      canInstallCli: false,
      canUpdateCli: true,
      cliManaged: true,
      updateAvailable: true,
      latestVersion: "1.5.11",
      profileId: "prof-1",
      connectionStatus: "disconnected",
      connectedAt: null,
      capabilities: null,
    };

    vi.mocked(apiPost).mockResolvedValueOnce({
      version: "1.5.11",
      binaryPath: "/var/lib/healthlog/bin/agy",
      alreadyInstalled: false,
    });
    vi.mocked(apiGet).mockRejectedValueOnce(new ApiError("Network error", 500));

    await profile.updateCli();

    const updated = useTestProfile();
    expect(updated.status?.cliVersion).toBe("1.5.11");
    expect(updated.status?.canUpdateCli).toBe(false);
    expect(updated.status?.updateAvailable).toBe(false);
    expect(updated.notice).toBe(
      "The connection test failed. Try again, or ask the operator to check the server.",
    );
    expect(toastWrittenOutcome).toHaveBeenCalledWith(
      "success",
      "Antigravity CLI updated successfully. (Version 1.5.11)",
    );
    expect(toastWrittenOutcome).not.toHaveBeenCalledWith(
      "failed",
      expect.anything(),
    );
  });

  it("subsequent refresh is server authoritative and never masks missing CLI", async () => {
    const profile = useTestProfile();

    vi.mocked(apiPost).mockResolvedValueOnce({
      version: "1.5.11",
      binaryPath: "/var/lib/healthlog/bin/agy",
      alreadyInstalled: false,
    });
    // Immediate refresh returns stale version
    vi.mocked(apiGet).mockResolvedValueOnce({
      cliInstalled: true,
      cliVersion: "1.5.10",
      canInstallCli: false,
      canUpdateCli: true,
      cliManaged: true,
      updateAvailable: true,
      latestVersion: "1.5.11",
      profileId: "prof-1",
      connectionStatus: "disconnected",
      connectedAt: null,
      capabilities: null,
    });

    await profile.updateCli();
    expect(useTestProfile().status?.cliVersion).toBe("1.5.11");

    // Subsequent refresh reports CLI was removed on host
    vi.mocked(apiGet).mockResolvedValueOnce({
      cliInstalled: false,
      cliVersion: null,
      canInstallCli: true,
      canUpdateCli: false,
      cliManaged: false,
      updateAvailable: false,
      latestVersion: null,
      profileId: "prof-1",
      connectionStatus: "disconnected",
      connectedAt: null,
      capabilities: null,
    });

    await profile.refresh();

    const updated = useTestProfile();
    expect(updated.status?.cliInstalled).toBe(false);
    expect(updated.status?.cliVersion).toBeNull();
    expect(updated.status?.canInstallCli).toBe(true);
  });

  it("does not synthesize fake connection/profile data if current status is null", async () => {
    const profile = useTestProfile();
    // Simulate null status before initial fetch finishes
    profile.status = null;
    stateStore[0] = null;

    vi.mocked(apiPost).mockResolvedValueOnce({
      version: "1.5.11",
    });
    // Mock refresh to do nothing during test
    vi.mocked(apiGet).mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof apiGet>>,
    );

    await profile.installCli();

    // Does not invent fake profileId or connectionStatus when current was null
    expect(stateStore[0]).toBeNull();
  });

  it("does not disable flags when version is absent from install/update response", async () => {
    const profile = useTestProfile();
    stateStore[0] = {
      cliInstalled: false,
      canInstallCli: true,
      cliVersion: null,
      canUpdateCli: false,
      cliManaged: true,
      updateAvailable: false,
      latestVersion: null,
      profileId: null,
      connectionStatus: "disconnected",
      connectedAt: null,
      capabilities: null,
    };

    vi.mocked(apiPost).mockResolvedValueOnce({});
    vi.mocked(apiGet).mockResolvedValueOnce(stateStore[0]);

    await profile.installCli();

    const updated = useTestProfile();
    expect(updated.status?.canInstallCli).toBe(true);
    expect(updated.status?.cliInstalled).toBe(false);
  });

  it("does not swallow errors in unrelated actions during refresh", async () => {
    const profile = useTestProfile();

    vi.mocked(apiPost).mockResolvedValueOnce({ reason: null });
    vi.mocked(apiGet).mockRejectedValueOnce(new ApiError("Network error", 500));

    await profile.test();

    // Error in test propagates to run's catch, setting notice
    expect(useTestProfile().notice).toBe(
      "The connection test failed. Try again, or ask the operator to check the server.",
    );
    // Unrelated actions do not fire failure toasts
    expect(toastWrittenOutcome).not.toHaveBeenCalledWith(
      "failed",
      expect.anything(),
    );
  });

  it("installCli also calls apiPost with signal: null and shows installed version", async () => {
    const profile = useTestProfile();

    vi.mocked(apiPost).mockResolvedValueOnce({
      version: "1.5.11",
      binaryPath: "/var/lib/healthlog/bin/agy",
      alreadyInstalled: false,
    });

    await profile.installCli();

    expect(apiPost).toHaveBeenCalledWith(
      "/api/antigravity/install",
      {},
      { signal: null },
    );

    expect(toastWrittenOutcome).toHaveBeenCalledWith(
      "success",
      "Antigravity CLI installed successfully. (Version 1.5.11)",
    );
    const updated = useTestProfile();
    expect(updated.status?.cliInstalled).toBe(true);
    expect(updated.status?.canInstallCli).toBe(false);
  });
});

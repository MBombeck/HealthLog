/**
 * The restore dialog's contents box asks once and says honestly why it has
 * nothing to show.
 *
 * A copy from an earlier version is read whole on the server, which took two
 * minutes for a large record; the dialog stopped waiting, retried, and the
 * server read the whole copy a second time (#1031). Pinned here: the preview
 * query is never retried and carries its own timeout, and a timeout reads as
 * "still being read", not as "could not be read".
 *
 * Mutation check: drop `retry: false` and the first case goes red; classify a
 * timeout as unavailable and the second goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiError } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

const mocks = vi.hoisted(() => ({
  queries: [] as Array<Record<string, unknown>>,
  apiGet: vi.fn(async () => ({ summary: {} })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/backups",
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/api/api-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/api-fetch")>();
  return { ...actual, apiGet: mocks.apiGet };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: Record<string, unknown>) => {
    mocks.queries.push(options);
    return {
      data: {
        rows: [
          {
            id: "b1",
            userId: "u1",
            username: "self-hoster",
            type: "WEEKLY_AUTO",
            sizeBytes: 1024,
            createdAt: "2026-09-01T03:00:00.000Z",
          },
        ],
        preWipeCopyDays: 14,
        schedule: {
          lastSuccessAt: "2026-09-01T03:00:00.000Z",
          lastSuccessAgeDays: 2,
          staleAfterDays: 9,
          stale: false,
          lastRun: null,
          lastRunFailed: false,
        },
      },
      isLoading: false,
      isError: false,
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    variables: undefined,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "testuser", role: "ADMIN" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import {
  RestorePreview,
  restorePreviewFailure,
} from "../backups/restore-dialog";

describe("restore preview query", () => {
  it("is never retried and waits a bounded time", async () => {
    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <RestorePreview backupId="b1" open />
      </I18nProvider>,
    );
    const key = JSON.stringify(queryKeys.adminBackupSummary("b1"));
    const preview = mocks.queries.find(
      (options) => JSON.stringify(options.queryKey) === key,
    );
    expect(preview).toBeDefined();
    expect(preview!.retry).toBe(false);

    await (preview!.queryFn as () => Promise<unknown>)();
    const [path, init] = mocks.apiGet.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe("/api/admin/backups/b1/summary");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("restorePreviewFailure", () => {
  it("reads a timeout as a copy still being read", () => {
    const timeout = new DOMException("signal timed out", "TimeoutError");
    expect(restorePreviewFailure(timeout)).toBe("stillReading");
  });

  it("names a missing key", () => {
    expect(
      restorePreviewFailure(
        new ApiError("key", 422, {
          errorCode: "backup.key.missing",
          keyIds: ["v1"],
        }),
      ),
    ).toBe("keyMissing");
  });

  it("calls everything else unavailable", () => {
    expect(restorePreviewFailure(new ApiError("boom", 500))).toBe(
      "unavailable",
    );
    expect(restorePreviewFailure(new TypeError("offline"))).toBe("unavailable");
  });
});

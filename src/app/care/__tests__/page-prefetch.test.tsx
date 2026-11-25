import { afterEach, describe, expect, it, vi } from "vitest";
import { HydrationBoundary, hashKey } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { queryKeys } from "@/lib/query-keys";

/**
 * The `/care` server-prefetch key crux + fail-soft.
 *
 * The RSC wrapper (`src/app/care/page.tsx`) dehydrates the Vorsorge
 * reminder list under the SAME zero-arg factory key the client hook
 * (`useMeasurementReminders`) mounts on, via the shared
 * `listMeasurementReminders` read — so the checkups list paints from the
 * first HTML. These tests pin the seeded key (byte-identical hash), the
 * JSON-wire shape, and that every error path fails soft to the bare client.
 */

const getUnswitchedSession = vi.fn();
const listMeasurementReminders = vi.fn();

vi.mock("@/lib/auth/acting-carrier", () => ({
  getUnswitchedSession: () => getUnswitchedSession(),
}));
vi.mock("@/lib/measurement-reminders/list-read", () => ({
  listMeasurementReminders: (userId: string) =>
    listMeasurementReminders(userId),
}));
vi.mock("../page-client", () => ({ default: () => null }));

import CarePage from "../page";

const SESSION = { user: { id: "u1", timezone: "Europe/Berlin" } };

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.DASHBOARD_SSR_PREFETCH;
});

function queriesOf(
  el: ReactElement,
): { queryHash: string; state: { data: unknown } }[] {
  if (el.type !== HydrationBoundary) return [];
  const props = el.props as {
    state?: { queries: { queryHash: string; state: { data: unknown } }[] };
  };
  return props.state?.queries ?? [];
}

describe("/care RSC prefetch", () => {
  it("dehydrates the reminder list under the client's factory key", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    listMeasurementReminders.mockResolvedValue([
      { id: "r1", label: "Blood pressure", nextDueAt: null },
    ]);

    const el = (await CarePage()) as ReactElement;
    const hashes = queriesOf(el).map((q) => q.queryHash);
    expect(hashes).toContain(hashKey(queryKeys.measurementReminders()));
    expect(listMeasurementReminders).toHaveBeenCalledWith("u1");
  });

  it("JSON-round-trips the list to the wire shape", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    const createdAt = new Date("2026-07-18T06:00:00.000Z");
    listMeasurementReminders.mockResolvedValue([{ id: "r1", createdAt }]);

    const el = (await CarePage()) as ReactElement;
    const seeded = queriesOf(el).find(
      (q) => q.queryHash === hashKey(queryKeys.measurementReminders()),
    );
    expect((seeded!.state.data as { createdAt: unknown }[])[0]!.createdAt).toBe(
      createdAt.toISOString(),
    );
  });

  it("fails soft to the bare client when the read throws", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    listMeasurementReminders.mockRejectedValue(new Error("db blip"));

    const el = (await CarePage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
  });

  // Null also means "acting on somebody else's record" — `getUnswitchedSession`
  // collapses both into the same answer, and the page treats them the same.
  it("fails soft when there is no session", async () => {
    getUnswitchedSession.mockResolvedValue(null);
    const el = (await CarePage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(listMeasurementReminders).not.toHaveBeenCalled();
  });

  it("honours the DASHBOARD_SSR_PREFETCH kill-switch", async () => {
    process.env.DASHBOARD_SSR_PREFETCH = "false";
    const el = (await CarePage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(getUnswitchedSession).not.toHaveBeenCalled();
  });
});

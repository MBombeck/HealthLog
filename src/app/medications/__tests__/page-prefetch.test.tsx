import { afterEach, describe, expect, it, vi } from "vitest";
import { HydrationBoundary, hashKey } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { queryKeys } from "@/lib/query-keys";

/**
 * v1.30.x — the `/medications` server-prefetch key crux + fail-soft.
 *
 * The RSC wrapper (`src/app/medications/page.tsx`) dehydrates the medications
 * list under `queryKeys.medications()` so the client cell reads it back on
 * mount instead of flashing skeletons. These tests pin the load-bearing rules:
 *  - the server dehydrates under the EXACT client key (byte-identical hash);
 *  - the value is JSON-round-tripped to the wire shape (Dates → ISO strings);
 *  - any prefetch error / a disabled module / no session fails soft to the
 *    bare client path (the client cell owns the fetch).
 */

const getUnswitchedSession = vi.fn();
const resolveModuleMap = vi.fn();
const readMedicationsListCached = vi.fn();

vi.mock("@/lib/auth/acting-carrier", () => ({
  getUnswitchedSession: () => getUnswitchedSession(),
}));
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: (id: string) => resolveModuleMap(id),
}));
vi.mock("@/lib/medications/list-read", () => ({
  readMedicationsListCached: (u: unknown) => readMedicationsListCached(u),
}));
vi.mock("../page-client", () => ({
  default: () => null,
}));

import MedicationsPage from "../page";

const SESSION = {
  user: { id: "u1", timezone: "Europe/Berlin", disableCoach: false },
};

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.DASHBOARD_SSR_PREFETCH;
});

/** The single dehydrated query on a HydrationBoundary element, or null. */
function dehydratedQuery(
  el: ReactElement,
): { queryHash: string; state: { data: unknown } } | null {
  if (el.type !== HydrationBoundary) return null;
  const props = el.props as {
    state?: { queries: { queryHash: string; state: { data: unknown } }[] };
  };
  const q = props.state?.queries?.[0];
  return q ? { queryHash: q.queryHash, state: q.state } : null;
}

describe("/medications RSC prefetch", () => {
  it("dehydrates the list under the EXACT client key (byte-identical hash)", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    resolveModuleMap.mockResolvedValue({ medications: true });
    readMedicationsListCached.mockResolvedValue([
      { id: "m1", name: "Ramipril" },
    ]);

    const el = (await MedicationsPage()) as ReactElement;
    const q = dehydratedQuery(el);
    expect(q).not.toBeNull();
    // The client cell looks up `queryKeys.medications()`; the server MUST have
    // dehydrated under the same hash or the prefetch silently no-ops.
    expect(q!.queryHash).toBe(hashKey(queryKeys.medications()));
    // The route's answer, the caller's registry search included (none here).
    expect(q!.state.data).toEqual([
      { id: "m1", name: "Ramipril", leafletSearch: null },
    ]);
  });

  it("JSON-round-trips the value to the wire shape (Dates → ISO strings)", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    resolveModuleMap.mockResolvedValue({ medications: true });
    const takenAt = new Date("2026-07-18T08:30:00.000Z");
    readMedicationsListCached.mockResolvedValue([
      { id: "m1", createdAt: takenAt, schedules: [{ id: "s1" }] },
    ]);

    const el = (await MedicationsPage()) as ReactElement;
    const q = dehydratedQuery(el);
    // A Date must land as its ISO string — the shape the client's
    // (await res.json()).data would carry — never a live Date object.
    expect((q!.state.data as { createdAt: unknown }[])[0].createdAt).toBe(
      takenAt.toISOString(),
    );
  });

  it("fails soft to the bare client when the read throws", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    resolveModuleMap.mockResolvedValue({ medications: true });
    readMedicationsListCached.mockRejectedValue(new Error("db blip"));

    const el = (await MedicationsPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
  });

  it("skips the prefetch when the medications module is off", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    resolveModuleMap.mockResolvedValue({ medications: false });

    const el = (await MedicationsPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(readMedicationsListCached).not.toHaveBeenCalled();
  });

  // Null also means "acting on somebody else's record" — `getUnswitchedSession`
  // collapses both into the same answer, and the page treats them the same.
  it("fails soft when there is no session", async () => {
    getUnswitchedSession.mockResolvedValue(null);
    const el = (await MedicationsPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(readMedicationsListCached).not.toHaveBeenCalled();
  });

  it("honours the DASHBOARD_SSR_PREFETCH kill-switch (no session read)", async () => {
    process.env.DASHBOARD_SSR_PREFETCH = "false";
    const el = (await MedicationsPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(getUnswitchedSession).not.toHaveBeenCalled();
  });
});

/**
 * The event types a person is shown a switch for.
 *
 * The preferences read lists `eventTypesForRole(role)` as the matrix rows and
 * serves stored rows only for those. An event nothing sends is listed for
 * nobody; backup health for admins only.
 */
import { describe, expect, it } from "vitest";

import {
  EVENT_TYPES,
  UNSENT_EVENT_TYPES,
  eventTypesForRole,
  isSentEventType,
} from "@/lib/notifications/types";

describe("eventTypesForRole", () => {
  it.each(["USER", "ADMIN"])("lists no event nothing sends (%s)", (role) => {
    const listed: string[] = eventTypesForRole(role);
    expect(listed).toContain("MEDICATION_REMINDER");
    for (const unsent of UNSENT_EVENT_TYPES) {
      expect(listed).not.toContain(unsent);
    }
  });

  it("lists backup health for an admin only", () => {
    expect(eventTypesForRole("USER")).not.toContain("BACKUP_HEALTH");
    expect(eventTypesForRole("ADMIN")).toContain("BACKUP_HEALTH");
  });

  it("keeps the declaration order", () => {
    expect(eventTypesForRole("ADMIN")).toEqual(
      EVENT_TYPES.filter((type) => isSentEventType(type)),
    );
  });

  it("knows no event outside the union", () => {
    expect(isSentEventType("NOT_AN_EVENT")).toBe(false);
  });
});

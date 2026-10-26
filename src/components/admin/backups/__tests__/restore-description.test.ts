/**
 * Undoing a data wipe with the copy it took brings the record back as it was
 * at the wipe, and nothing else: whatever arrived since is replaced, and the
 * connections, sharing, Guardian access and share links the wipe ended stay
 * ended. Both dialogs that lead there say so: the person's own confirmation
 * before the wipe, and the admin's before the restore of such a copy.
 */
import { describe, expect, it } from "vitest";

import { restoreDescription } from "../restore-dialog";
import { wipeConfirmBody } from "@/components/settings/advanced-section";

const t = (key: string) => key;

describe("what an undo of a data wipe does not bring back", () => {
  it("is said before an admin restores a copy a data wipe took, and only then", () => {
    expect(
      restoreDescription(
        { username: "u", type: "PRE_WIPE_1761300000000" },
        t,
        "when",
      ),
    ).toContain("admin.section.backups.restorePreWipeLimits");
    expect(
      restoreDescription({ username: "u", type: "WEEKLY_AUTO" }, t, "when"),
    ).not.toContain("restorePreWipeLimits");
  });

  it("is said before the person deletes their data, when a copy is kept", () => {
    expect(wipeConfirmBody(14, t)).toContain(
      "settings.dangerZoneRestoreLimits",
    );
    expect(wipeConfirmBody(0, t)).not.toContain("dangerZoneRestoreLimits");
  });
});

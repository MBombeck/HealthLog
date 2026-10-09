/**
 * The overview arrange editor and the pill manager share one layout blob.
 * A pill save followed by a section save must keep the pill order, and an
 * untouched section draft must follow the server copy (the pill manager also
 * flips the "ecg" section) instead of reading as a pending edit.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_INSIGHTS_LAYOUT,
  type InsightsLayout,
} from "@/lib/insights-layout";
import {
  arrangeSavePayload,
  arrangementSignature,
  reconcileArrangeDraft,
  seedArrangeDraft,
} from "@/lib/insights-arrange-draft";

function clone(layout: InsightsLayout): InsightsLayout {
  return {
    version: layout.version,
    sections: layout.sections.map((s) => ({ ...s })),
    tiles: layout.tiles.map((t) => ({ ...t })),
  };
}

/** The layout after a pill save: tile order reversed, ECG section hidden. */
function afterPillSave(base: InsightsLayout): InsightsLayout {
  const next = clone(base);
  const n = next.tiles.length;
  next.tiles = next.tiles.map((t) => ({ ...t, order: n - 1 - t.order }));
  next.sections = next.sections.map((s) =>
    s.id === "ecg" ? { ...s, visible: false } : s,
  );
  return next;
}

describe("insights arrange draft", () => {
  it("keeps a pill order saved after the editor mounted", () => {
    const mounted = clone(DEFAULT_INSIGHTS_LAYOUT);
    const draft = seedArrangeDraft(mounted.sections);
    const server = afterPillSave(mounted);

    // The user then moves a section and saves.
    const reconciled = reconcileArrangeDraft(draft, server.sections) ?? draft;
    const moved = reconciled.sections.map((s, i, all) =>
      i === 0 ? { ...s, order: all.length } : { ...s, order: s.order - 1 },
    );
    const body = arrangeSavePayload(moved, server);

    expect(body.tiles).toEqual(server.tiles);
    expect(body.tiles).not.toEqual(mounted.tiles);
    // The ECG flip from the pill manager survives too.
    expect(body.sections.find((s) => s.id === "ecg")?.visible).toBe(false);
  });

  it("re-seeds an untouched draft so a pill-manager ECG flip is not dirty", () => {
    const mounted = clone(DEFAULT_INSIGHTS_LAYOUT);
    const draft = seedArrangeDraft(mounted.sections);
    const server = afterPillSave(mounted);

    const next = reconcileArrangeDraft(draft, server.sections);
    expect(next).not.toBeNull();
    expect(arrangementSignature(next!.sections)).toBe(
      arrangementSignature(server.sections),
    );
  });

  it("keeps the user's own edits when the server copy moves", () => {
    const mounted = clone(DEFAULT_INSIGHTS_LAYOUT);
    const draft = seedArrangeDraft(mounted.sections);
    const edited = {
      ...draft,
      sections: draft.sections.map((s) =>
        s.id === "trends" ? { ...s, visible: !s.visible } : s,
      ),
    };
    const server = afterPillSave(mounted);

    const next = reconcileArrangeDraft(edited, server.sections);
    expect(next?.sections).toEqual(edited.sections);
    expect(next?.seeded).toBe(arrangementSignature(server.sections));
  });

  it("does nothing while the server copy is unchanged", () => {
    const draft = seedArrangeDraft(DEFAULT_INSIGHTS_LAYOUT.sections);
    expect(
      reconcileArrangeDraft(draft, DEFAULT_INSIGHTS_LAYOUT.sections),
    ).toBeNull();
  });
});

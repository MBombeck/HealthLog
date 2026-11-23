/**
 * The save receipt's Edit: a link to the entry's own edit sheet on its page,
 * beside Undo and under the same right, for one entry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), dismiss: vi.fn() }),
}));

import { toast } from "sonner";
import { showEntrySavedToast } from "@/components/forms/entry-saved-toast";
import { entryEditHref } from "@/components/forms/entry-edit-link";

const t = (key: string) => key;
const undo = () => Promise.resolve();

function cancelOf(): unknown {
  const options = vi.mocked(toast.success).mock.calls.at(-1)?.[1] as
    { cancel?: unknown } | undefined;
  return options?.cancel;
}

beforeEach(() => vi.mocked(toast.success).mockClear());

describe("entryEditHref", () => {
  it("names each page and its parameter", () => {
    expect(entryEditHref("measurement", "m1")).toBe("/measurements?reading=m1");
    expect(entryEditHref("mood", "e 1")).toBe("/mood?entry=e%201");
    expect(entryEditHref("symptom", "s1")).toBe("/illness?occurrence=s1");
  });
});

describe("the receipt's Edit", () => {
  it("links to the entry's edit sheet beside Undo", () => {
    showEntrySavedToast({
      t,
      label: "Weight",
      undo,
      edit: { kind: "measurement", ids: ["m1"] },
    });
    const cancel = cancelOf();
    expect(isValidElement(cancel)).toBe(true);
    const props = (cancel as ReactElement<Record<string, unknown>>).props;
    expect(props.href).toBe("/measurements?reading=m1");
    expect(props["data-button"]).toBe(true);
    expect(props.children).toBe("common.edit");
  });

  it("is absent without the right to undo, and for several entries", () => {
    showEntrySavedToast({
      t,
      label: "Mood",
      edit: { kind: "mood", ids: ["e1"] },
    });
    expect(cancelOf()).toBeUndefined();
    showEntrySavedToast({
      t,
      label: "Headache, Nausea",
      undo,
      edit: { kind: "symptom", ids: ["s1", "s2"] },
    });
    expect(cancelOf()).toBeUndefined();
  });
});

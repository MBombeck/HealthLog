/**
 * The one-time note on the correlation surface after the v1.42 engine change.
 *
 * Three properties: it shows for a record that had findings under the earlier
 * engine, it never shows for an account without them (every account created
 * since, and a response from an older server that lacks the flag), and once
 * closed it stays closed on the next mount.
 *
 * The project runs SSR-only component tests, so nothing here clicks. The
 * close path is driven by calling the component as a plain function and
 * invoking the dismiss button's own `onClick` from the returned tree, then
 * mounting again against the same storage. `useState` is replaced by a
 * stateless stand-in for that; persistence across mounts is the property, and
 * it lives in storage, not in component state.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(init: T | (() => T)) => [
      typeof init === "function" ? (init as () => T)() : init,
      () => undefined,
    ],
  };
});
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "viewer-1" }, isAuthenticated: true }),
}));
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));
vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key }),
}));

import {
  CorrelationSeasonalNote,
  correlationSeasonalNoteStorageKey,
} from "../correlation-seasonal-note";

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function render(flag: boolean | undefined): string {
  return renderToStaticMarkup(
    <CorrelationSeasonalNote findingsBeforeSeasonalAdjustment={flag} />,
  );
}

function findBySlot(node: ReactNode, slot: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findBySlot(child, slot);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as { "data-slot"?: string; children?: ReactNode };
  if (props["data-slot"] === slot) return node;
  return findBySlot(props.children, slot);
}

describe("CorrelationSeasonalNote", () => {
  it("shows for a record that had findings before the seasonal adjustment", () => {
    const html = render(true);
    expect(html).toContain('data-slot="correlation-seasonal-note"');
    expect(html).toContain("insights.pattern.seasonalNote");
    expect(html).toContain('aria-label="insights.pattern.seasonalNoteDismiss"');
  });

  it("stays away for an account without earlier findings", () => {
    expect(render(false)).toBe("");
  });

  it("stays away when the server does not send the flag", () => {
    expect(render(undefined)).toBe("");
  });

  it("does not come back once closed", () => {
    const tree = CorrelationSeasonalNote({
      findingsBeforeSeasonalAdjustment: true,
    });
    const button = findBySlot(tree, "correlation-seasonal-note-dismiss");
    expect(button).not.toBeNull();
    (button!.props as { onClick: () => void }).onClick();

    expect(store.get(correlationSeasonalNoteStorageKey("viewer-1"))).toBe("1");
    expect(render(true)).toBe("");
  });

  it("is remembered per viewer, not per browser", () => {
    store.set(correlationSeasonalNoteStorageKey("someone-else"), "1");
    expect(render(true)).toContain('data-slot="correlation-seasonal-note"');
  });

  it("still shows and still closes when storage is unavailable", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    const tree = CorrelationSeasonalNote({
      findingsBeforeSeasonalAdjustment: true,
    });
    const button = findBySlot(tree, "correlation-seasonal-note-dismiss");
    expect(button).not.toBeNull();
    expect(() =>
      (button!.props as { onClick: () => void }).onClick(),
    ).not.toThrow();
  });
});

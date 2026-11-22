/**
 * The relay question renders only for an admin of a server where it is open,
 * and offers its two answers with the same weight.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  }),
}));

type Relay = {
  operatorDecision: "undecided" | "on" | "off";
  canDecide: boolean;
};
const auth = vi.hoisted(() => ({
  role: "ADMIN" as "ADMIN" | "USER",
  relay: null as null | Relay,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: auth.role, push: { relay: auth.relay } },
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { PushRelayQuestion } from "../push-relay-question";

function render(role: "ADMIN" | "USER", relay: Relay | null) {
  auth.role = role;
  auth.relay = relay;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <PushRelayQuestion />
    </I18nProvider>,
  );
}

const OPEN: Relay = { operatorDecision: "undecided", canDecide: true };

describe("<PushRelayQuestion>", () => {
  it("asks an admin while the question is open, with two equal answers", () => {
    const html = render("ADMIN", OPEN);
    expect(html).toContain(
      "Send push notifications through the HealthLog relay?",
    );
    const buttons = [
      ...html.matchAll(
        /<button[^>]*data-slot="push-relay-question-(yes|no)"[^>]*>/g,
      ),
    ];
    expect(buttons.map((m) => m[1]).sort()).toEqual(["no", "yes"]);
    const classOf = (tag: string) => /class="([^"]*)"/.exec(tag)?.[1];
    expect(classOf(buttons[0][0])).toBe(classOf(buttons[1][0]));
    // No way to put it away without answering.
    expect(html).not.toMatch(/dismiss|Got it|Not now/i);
  });

  it("is not shown once answered, with nothing to decide, or to anyone else", () => {
    expect(render("ADMIN", { ...OPEN, operatorDecision: "on" })).toBe("");
    expect(render("ADMIN", { ...OPEN, operatorDecision: "off" })).toBe("");
    expect(render("ADMIN", { ...OPEN, canDecide: false })).toBe("");
    expect(render("ADMIN", null)).toBe("");
    expect(render("USER", OPEN)).toBe("");
  });
});

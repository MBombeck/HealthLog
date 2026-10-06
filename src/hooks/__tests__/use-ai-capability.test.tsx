/**
 * `useAiCapability` hands a surface the server's answer and fails closed until
 * there is one: loading, no query client, or a payload without the block all
 * read as unavailable, so no AI surface paints before the answer is known.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let authUser: unknown = null;
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: authUser }),
}));

import {
  useAiCapability,
  useAiProviderState,
  useCoachReasoning,
} from "../use-ai-capability";
import type { AiCapabilityKey } from "@/lib/ai/capabilities/types";

function Probe({ capability }: { capability: AiCapabilityKey }) {
  const state = useAiCapability(capability);
  const provider = useAiProviderState();
  return <span>{JSON.stringify({ state, provider })}</span>;
}

function render(capability: AiCapabilityKey, withClient = true) {
  const tree = <Probe capability={capability} />;
  const html = renderToStaticMarkup(
    withClient ? (
      <QueryClientProvider client={new QueryClient()}>
        {tree}
      </QueryClientProvider>
    ) : (
      tree
    ),
  );
  const json = html.replace(/^<span>|<\/span>$/g, "").replace(/&quot;/g, '"');
  return JSON.parse(json) as {
    state: { available: boolean; reason: string | null };
    provider: { configured: boolean; canConfigure: boolean };
  };
}

const UNKNOWN = {
  available: false,
  reason: "check_failed",
  onDeviceAllowed: false,
};

describe("useAiCapability", () => {
  it("reads the server's answer for the capability", () => {
    authUser = {
      ai: {
        capabilities: {
          briefing: { available: true, reason: null, onDeviceAllowed: true },
          coach: {
            available: false,
            reason: "user_disabled",
            onDeviceAllowed: false,
          },
        },
        provider: { configured: true, managedBy: "user", canConfigure: true },
      },
    };
    expect(render("briefing").state).toEqual({
      available: true,
      reason: null,
      onDeviceAllowed: true,
    });
    expect(render("coach").state.reason).toBe("user_disabled");
    expect(render("coach").provider.configured).toBe(true);
  });

  it("fails closed while the account payload has not arrived", () => {
    authUser = null;
    expect(render("briefing").state).toEqual(UNKNOWN);
    expect(render("briefing").provider).toEqual({
      configured: false,
      managedBy: null,
      canConfigure: false,
      responseTimeoutMs: 60_000,
    });
  });

  it("fails closed for a payload that carries no block", () => {
    authUser = { ai: null };
    expect(render("statusText").state).toEqual(UNKNOWN);
  });

  it("fails closed for a capability the block does not name", () => {
    authUser = {
      ai: {
        capabilities: {},
        provider: { configured: false, managedBy: null, canConfigure: true },
      },
    };
    expect(render("documentAi").state).toEqual(UNKNOWN);
  });

  it("fails closed without a query client", () => {
    authUser = {
      ai: {
        capabilities: {
          briefing: { available: true, reason: null, onDeviceAllowed: true },
        },
        provider: { configured: true, managedBy: "user", canConfigure: true },
      },
    };
    expect(render("briefing", false).state).toEqual(UNKNOWN);
  });
});

function ReasoningProbe() {
  return <span>{JSON.stringify(useCoachReasoning())}</span>;
}

function renderReasoning(withClient = true): unknown {
  const html = renderToStaticMarkup(
    withClient ? (
      <QueryClientProvider client={new QueryClient()}>
        <ReasoningProbe />
      </QueryClientProvider>
    ) : (
      <ReasoningProbe />
    ),
  );
  return JSON.parse(
    html.replace(/^<span>|<\/span>$/g, "").replace(/&quot;/g, '"'),
  );
}

describe("useCoachReasoning", () => {
  const STATE = {
    level: "low",
    preference: "high",
    maxLevel: "low",
    available: true,
    offIsReal: true,
    source: "admin_cap",
  };

  it("hands over the server's resolved block untouched", () => {
    authUser = { coachReasoning: STATE };
    expect(renderReasoning()).toEqual(STATE);
  });

  it("is null while the payload is not there or carries no block", () => {
    authUser = null;
    expect(renderReasoning()).toBeNull();
    authUser = { coachReasoning: null };
    expect(renderReasoning()).toBeNull();
    authUser = { coachReasoning: STATE };
    expect(renderReasoning(false)).toBeNull();
  });
});

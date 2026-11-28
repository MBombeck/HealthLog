/**
 * The operator's relay decision (`AppSettings.pushRelayDecision`) has one
 * writer, and the relay question has one face.
 *
 * The class this holds shut: a second switch beside the relay's own. The
 * decision is written only by `recordRelayDecision`, and that only from the
 * relay's own on and off paths (`registration.ts`), so `on` cannot be stored
 * without a registration that took, and no route or job can set the answer
 * on its own. The admin routes reach those paths through `operator-switch.ts`
 * only. And every surface that asks the question renders the one component
 * that reads the published decision, so no surface asks again after a no.
 *
 * Matchers are textual and assert non-zero counts, so a rename that leaves
 * them matching nothing fails instead of passing.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  walkSourceFiles,
} from "@/__tests__/helpers/source-files";

const SRC = join(process.cwd(), "src");

const tree = walkSourceFiles(SRC, { floor: 2000 })
  .filter((rel) => !rel.startsWith("generated/"))
  .filter((rel) => !rel.includes("__tests__/") && !/\.test\.tsx?$/.test(rel))
  .map((rel) => ({
    path: `src/${rel}`,
    text: readSourceText(join(SRC, rel)),
  }));

function withMatch(re: RegExp): string[] {
  return tree.filter((f) => re.test(f.text)).map((f) => f.path);
}

describe("push relay decision writers", () => {
  it("writes the column only in the decision module", () => {
    // A write names the column as a data key (`pushRelayDecision: value`).
    const writers = tree
      .filter((f) => /pushRelayDecision\s*:\s*(?!true\b)[^\s,}]/.test(f.text))
      .map((f) => f.path);
    expect(writers.length).toBeGreaterThan(0);
    expect(writers.sort()).toEqual(
      [
        // Its two writes, `create` and `update` of the upsert.
        "src/lib/push-relay/operator-decision.ts",
        // The backup's verdict and payload schema, not writes.
        "src/lib/export/app-settings-backup-schema.ts",
        "src/lib/export/app-settings-columns.ts",
      ].sort(),
    );
  });

  it("records the decision only from the relay's own on and off paths", () => {
    const callers = withMatch(/recordRelayDecision\(/);
    expect(callers.sort()).toEqual(
      [
        "src/lib/push-relay/operator-decision.ts",
        "src/lib/push-relay/registration.ts",
      ].sort(),
    );
  });

  it("turns the relay on and off from the admin routes through the shared switch only", () => {
    const routes = tree.filter((f) => f.path.startsWith("src/app/"));
    const direct = routes
      .filter((f) => /\b(enableRelay|disableRelay)\b/.test(f.text))
      .map((f) => f.path);
    expect(direct).toEqual([]);
    const switchUsers = routes
      .filter((f) => /\b(switchRelayOn|switchRelayOff)\b/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(switchUsers).toEqual([
      "src/app/api/admin/push-relay/decision/route.ts",
      "src/app/api/admin/push-relay/route.ts",
    ]);
  });

  it("asks the question through the one component that reads the decision", () => {
    const question = tree.find(
      (f) => f.path === "src/components/admin/push-relay-question.tsx",
    );
    expect(question?.text).toMatch(/operatorDecision !== "undecided"/);
    expect(question?.text).toMatch(/canDecide !== true/);
    const hosts = withMatch(/<PushRelayQuestion\s*\/>/).sort();
    expect(hosts).toEqual(["src/app/admin/page.tsx"]);
    // 1.50 — the server setup's relay step asks inline, with the same
    // confirmations, and only while the published decision is undecided.
    const step = tree.find(
      (f) => f.path === "src/components/onboarding/server/relay-step.tsx",
    );
    expect(step?.text).toMatch(/operatorDecision !== "undecided"/);
    expect(step?.text).toMatch(/canDecide !== true/);
    // The dashboard asks it as one row of its ask card, through the same
    // answer hook the card above uses, and only when the server put the row
    // into the digest's asks (`buildAdminAsk`, which reads the decision).
    const answerers = withMatch(/\busePushRelayAnswer\(/).sort();
    expect(answerers).toEqual([
      "src/components/admin/push-relay-question.tsx",
      "src/components/dashboard/today-asks.tsx",
    ]);
    expect(withMatch(/<ServerSetupNotice\s*\/>/)).toEqual([
      "src/app/admin/page.tsx",
    ]);
    // On the client, the answer route is called from the question's hook
    // only.
    const clientCallers = tree
      .filter((f) => !f.path.startsWith("src/app/api/"))
      .filter((f) => !f.path.startsWith("src/lib/"))
      .filter((f) => /["`]\/api\/admin\/push-relay\/decision["`]/.test(f.text))
      .map((f) => f.path);
    expect(clientCallers).toEqual(["src/components/admin/use-push-relay.ts"]);
  });
});

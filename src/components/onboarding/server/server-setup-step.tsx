"use client";

import type { ServerSetupStepId } from "@/lib/admin/server-setup";

import { AiStep } from "./ai-step";
import { FactorStep } from "./factor-step";
import { RecoveryStep } from "./recovery-step";
import { RelayStep } from "./relay-step";
import { SignupsStep } from "./signups-step";

/**
 * One step of the first-admin server setup (1.50). Each screen makes its
 * one decision and writes it through the domain's own admin route, then
 * records the step; the cards it used to embed stay under Admin, where every
 * row of Admin › Setup leads.
 */
export function ServerSetupStep({ step }: { step: ServerSetupStepId }) {
  switch (step) {
    case "account-mfa":
      return <FactorStep />;
    case "signups":
      return <SignupsStep />;
    case "relay":
      return <RelayStep />;
    case "ai":
      return <AiStep />;
    case "recovery":
      return <RecoveryStep />;
  }
}

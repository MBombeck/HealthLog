import { notFound, redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import {
  parseServerSetupSteps,
  serverSetupResumeStep,
} from "@/lib/admin/server-setup";
import { serverSetupOfferedHere } from "@/lib/admin/server-setup-store";

/**
 * 1.49 — `/onboarding/server`: the server setup's front door. Admins only, and
 * never on a demo deploy. Opens the first step still owed, or the first step
 * of a finished setup (re-opened from Admin → System status).
 */
export const dynamic = "force-dynamic";

export default async function ServerSetupIndexPage() {
  const session = await getSession();
  if (!session) redirect("/auth/login");
  if (session.user.role !== "ADMIN" || !serverSetupOfferedHere()) notFound();
  const row = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { serverSetupStepsJson: true },
  });
  const steps = parseServerSetupSteps(row?.serverSetupStepsJson ?? null);
  redirect(`/onboarding/server/${serverSetupResumeStep(steps)}`);
}

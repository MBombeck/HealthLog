/**
 * Apps whose Health Connect data the import leaves out because HealthLog
 * already receives the same readings from them directly.
 *
 * A Withings scale writes each weighing to Health Connect and to the Withings
 * cloud. When the account has the Withings integration connected, the
 * weighing arrives twice: once as `WITHINGS`, once inside the Health Connect
 * export. The cross-source merge only pairs manual entries with Apple Health,
 * so nothing would fold the two, and the reader's source ranking would show
 * one and keep the other. Leaving the app's records out of the import is the
 * exact fix; the ±2 s same-reading check in the importer stays as a safety
 * net for anything this list does not name.
 *
 * The list is per integration, by Android package name. Only integrations the
 * account has actually connected count; a person who uses the Fitbit app but
 * not HealthLog's Fitbit integration gets their Fitbit data from the export.
 *
 * Google Health is the Fitbit Web API's successor and carries what the Fitbit
 * app records (Fitbit devices, Pixel Watch), so it maps to the Fitbit app's
 * package as well.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export type DirectIntegration =
  "withings" | "fitbit" | "googleHealth" | "oura" | "polar" | "whoop";

export const INTEGRATION_PACKAGES: Readonly<
  Record<DirectIntegration, readonly string[]>
> = {
  withings: ["com.withings.wiscale2"],
  fitbit: ["com.fitbit.FitbitMobile"],
  googleHealth: ["com.fitbit.FitbitMobile"],
  oura: ["com.ouraring.oura"],
  polar: ["fi.polar.polarflow"],
  whoop: ["com.whoop.android"],
};

/** The integrations this account has connected right now. */
export async function connectedDirectIntegrations(
  prisma: PrismaClient,
  userId: string,
): Promise<DirectIntegration[]> {
  const [withings, fitbit, googleHealth, whoop, user] = await Promise.all([
    prisma.withingsConnection.count({ where: { userId } }),
    prisma.fitbitConnection.count({ where: { userId } }),
    prisma.googleHealthConnection.count({ where: { userId } }),
    prisma.whoopConnection.count({ where: { userId } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        polarAccessTokenEncrypted: true,
        ouraAccessTokenEncrypted: true,
      },
    }),
  ]);
  const out: DirectIntegration[] = [];
  if (withings > 0) out.push("withings");
  if (fitbit > 0) out.push("fitbit");
  if (googleHealth > 0) out.push("googleHealth");
  if (whoop > 0) out.push("whoop");
  if (user?.polarAccessTokenEncrypted) out.push("polar");
  if (user?.ouraAccessTokenEncrypted) out.push("oura");
  return out;
}

/** The package names to leave out for `integrations`. */
export function packagesToSkip(
  integrations: readonly DirectIntegration[],
): Set<string> {
  const out = new Set<string>();
  for (const integration of integrations) {
    for (const pkg of INTEGRATION_PACKAGES[integration]) out.add(pkg);
  }
  return out;
}

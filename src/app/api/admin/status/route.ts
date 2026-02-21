import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { readFileSync } from "node:fs";

// Build timestamp (set at build time via next.config)
const BUILD_TIME = process.env.BUILD_TIMESTAMP || new Date().toISOString();
const START_TIME = new Date().toISOString();

// Try to read git commit info
let gitCommit = process.env.GIT_COMMIT ?? "unknown";
try {
  const head = readFileSync(".git/HEAD", "utf-8").trim();
  if (head.startsWith("ref:")) {
    const ref = head.replace("ref: ", "");
    gitCommit = readFileSync(`.git/${ref}`, "utf-8").trim().slice(0, 8);
  } else {
    gitCommit = head.slice(0, 8);
  }
} catch {
  // In Docker or production, .git may not exist
}

export async function GET() {
  const session = await getSession();
  if (!session) return apiError("Nicht angemeldet", 401);
  if (session.user.role !== "ADMIN") return apiError("Kein Zugriff", 403);

  try {
    const [
      userCount,
      measurementCount,
      medicationCount,
      intakeEventCount,
      tokenCount,
      sessionCount,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.measurement.count(),
      prisma.medication.count(),
      prisma.medicationIntakeEvent.count(),
      prisma.apiToken.count({ where: { revoked: false } }),
      prisma.session.count(),
    ]);

    return apiSuccess({
      version: process.env.npm_package_version ?? "0.1.0",
      nodeVersion: process.version,
      gitCommit,
      buildTime: BUILD_TIME,
      startTime: START_TIME,
      database: "connected",
      counts: {
        users: userCount,
        measurements: measurementCount,
        medications: medicationCount,
        intakeEvents: intakeEventCount,
        activeTokens: tokenCount,
        activeSessions: sessionCount,
      },
    });
  } catch (err) {
    console.error("Admin status error:", err);
    return apiError("Status konnte nicht geladen werden", 500);
  }
}

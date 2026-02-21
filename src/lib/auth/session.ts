import { prisma } from "@/lib/db";
import { cookies } from "next/headers";
import type { User } from "@/generated/prisma/client";
import { ensureDbCompatibility } from "@/lib/db-compat";

const SESSION_COOKIE = "healthlog_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(
  userId: string,
  ipAddress?: string | null,
  userAgent?: string | null,
): Promise<string> {
  const session = await prisma.session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS),
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // OAuth callbacks (e.g. Withings) arrive via top-level cross-site redirect.
    // Lax keeps CSRF protection for unsafe methods while allowing this flow.
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_MS / 1000,
    path: "/",
  });

  return session.id;
}

export async function getSession(): Promise<{
  session: { id: string; expiresAt: Date };
  user: User;
} | null> {
  try {
    await ensureDbCompatibility();
  } catch (error) {
    console.error("DB compatibility check failed:", error);
  }

  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) {
    if (session) {
      await prisma.session.delete({ where: { id: sessionId } });
    }
    cookieStore.delete(SESSION_COOKIE);
    return null;
  }

  // Sliding expiry: refresh if more than 1 day old
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (
    session.expiresAt.getTime() - Date.now() <
    SESSION_MAX_AGE_MS - oneDayMs
  ) {
    const newExpiry = new Date(Date.now() + SESSION_MAX_AGE_MS);
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: newExpiry },
    });
    cookieStore.set(SESSION_COOKIE, session.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_MS / 1000,
      path: "/",
    });
  }

  return {
    session: { id: session.id, expiresAt: session.expiresAt },
    user: session.user,
  };
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (sessionId) {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
  }
  cookieStore.delete(SESSION_COOKIE);
}

export async function destroyAllSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

/**
 * Require an authenticated admin user.
 * Returns user if admin, null otherwise.
 */
export async function requireAdmin(): Promise<User | null> {
  const sessionData = await getSession();
  if (!sessionData) return null;
  if (sessionData.user.role !== "ADMIN") return null;
  return sessionData.user;
}

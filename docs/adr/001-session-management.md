# ADR-001: Custom Session Management over Auth Libraries

## Status

Accepted

## Context

We need session management for the app. Options considered:

1. **NextAuth.js / Auth.js** — popular but adds complexity, adapter churn, opinionated session handling
2. **Lucia** — deprecated (author recommends rolling your own)
3. **Custom sessions in PostgreSQL** — full control, minimal dependencies

## Decision

Custom server-side sessions stored in PostgreSQL.

## Rationale

- Passkeys are our primary auth mechanism — most auth libraries treat them as secondary
- We already have Prisma + PostgreSQL; adding a Session model is trivial
- Full control over cookie attributes, expiry, revocation
- No dependency on third-party auth library release cycles
- Health data requires strict session controls (revocation, audit logging)

## Implementation

- Sessions stored in `sessions` table (id, userId, expiresAt, ipAddress, userAgent)
- Session ID in HttpOnly, Secure, SameSite=Strict cookie
- 30-day sliding expiry (refreshed on each request)
- Session lookup via middleware in API routes
- Challenge storage for WebAuthn uses short-lived entries (5 min TTL)

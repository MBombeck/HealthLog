# Security Design

## Authentication

### Primary: Passkeys (WebAuthn)

- Registration and login via SimpleWebAuthn
- Stored as `Passkey` records with credential public key, counter, device type
- Replay protection via counter verification

### Fallback: Password

- Minimum 12 characters
- Strength checked via zxcvbn (rejects weak passwords even if length requirement met)
- Hashed with argon2id (via `@node-rs/argon2` or similar)

### Sessions

- Server-side sessions stored in PostgreSQL
- Secure, HttpOnly, SameSite=Strict cookies
- Session expiry: 30 days (sliding)
- Session revocation on password change / security events

### Optional 2FA (TOTP)

- Required for: data export, security settings changes
- TOTP secret encrypted at rest

## Encryption at Rest

### Application-Level Encryption

- Algorithm: AES-256-GCM
- Key: Derived from `ENCRYPTION_KEY` env variable
- What's encrypted:
  - Withings OAuth tokens (access + refresh)
  - User-provided OpenAI API keys
  - Sensitive notes on measurements
- Each encrypted value stored with its IV (nonce) and auth tag

## Transport Security

- HTTPS enforced (via reverse proxy / Coolify)
- HSTS headers
- No sensitive data in URLs or query strings

## API Security

### External Ingest Endpoint (`/api/ingest/medication`)

- Authenticated via Bearer token or HMAC signature
- Tokens hashed (SHA-256) before storage
- Idempotency via `idempotencyKey`
- Rate limited

### Webhook Endpoint (`/api/webhooks/withings`)

- Signature verification per Withings spec
- Payload validation
- Enqueue only (no direct DB writes)

## Rate Limiting

- Auth endpoints: 5 attempts / 15 min per IP
- API endpoints: 100 req / min per user
- Ingest endpoint: 30 req / min per token
- Implementation: in-memory initially, Redis-backed when available

## Security Headers (CSP)

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.openai.com https://wbsapi.withings.net;
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

## Audit Logging

- All auth events (login, register, failed attempts)
- Data mutations (create, update, delete measurements/meds)
- External API calls (Withings sync, OpenAI insights)
- Export events
- No sensitive data in audit logs (no tokens, no measurement values)

## Threat Model (Short)

| Threat                | Mitigation                                              |
| --------------------- | ------------------------------------------------------- |
| Stolen session cookie | HttpOnly, Secure, SameSite=Strict, server-side sessions |
| Brute force auth      | Rate limiting, passkeys (no passwords to brute)         |
| DB compromise         | App-level encryption for tokens, hashed API keys        |
| XSS                   | CSP, React auto-escaping, no dangerouslySetInnerHTML    |
| CSRF                  | SameSite cookies, origin checking on mutations          |
| Withings token theft  | AES-256-GCM encryption at rest                          |
| OpenAI data leakage   | Aggregated-only mode by default, user opt-in for raw    |
| SQL injection         | Prisma parameterized queries                            |

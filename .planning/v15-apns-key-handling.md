---
file: .planning/v15-apns-key-handling.md
purpose: Lifecycle, rotation, access control, and backup policy for the APNs .p8 private key
audience: Marc + iOS-Claude + future server agents
estimated_read_time: 5 min
last_updated: 2026-05-15
---

# APNs .p8 Private Key — Handling Policy

## TL;DR

- Key ID: `M9WAFLNC2U`
- Team ID: `S8WDX4W5KX`
- Bundle ID: `dev.healthlog.app`
- File: `~/Downloads/AuthKey_M9WAFLNC2U.p8` (single Apple download; not re-downloadable)
- **Never** in: git repo, GitHub Release, CI logs, CHANGELOG, docs site, marketing
- **OK** in: Marc's local FS, server env vars (apps01 Coolify DB + edge-01 `.env`), 1Password/Bitwarden vault, encrypted offline backup

## What this is

Apple's APNs (Apple Push Notification service) needs an ECDSA private key to sign every push payload. The `.p8` file IS that key. Apple gives it to you ONCE when you create a Key in App Store Connect → Keys section. **You cannot re-download** — if you lose it, you must revoke + generate a new one.

## Where it lives today (v1.4.25.1)

| Location | Contents | Why | Risk if leaked |
|---|---|---|---|
| Marc's local: `~/Downloads/AuthKey_M9WAFLNC2U.p8` | Full .p8 PEM, 257 bytes | Originator | An attacker with this can dispatch arbitrary push notifications to all iOS app users |
| apps01 Coolify env var `APNS_KEY` | Same content with `\n` escapes (single-line 12-factor) | Server signing for push dispatch | Same |
| edge-01 .env file `APNS_KEY=...` | Same | Demo-server push dispatch | Same (lower-impact — demo) |

## Server env-var format (12-factor)

The server expects the .p8 with literal `\n` escape sequences (backslash + lowercase n), NOT actual newline characters. The conversion happens in `src/lib/notifications/senders/apns.ts:151`:

```typescript
signingKey = inlineKey.replace(/\\n/g, "\n");
```

So .env entry on edge-01:

```
APNS_KEY=-----BEGIN PRIVATE KEY-----\nMIGTAg...\nbw81BG89\n-----END PRIVATE KEY-----
```

(All on one line. Backslash-n is literal. No actual newlines.)

For apps01, Coolify env-var API stores the same way.

## Access control

**Who has it**: Marc + the two servers + (recommended) 1Password vault for backup.

**Who must NOT have it**: any subagent that doesn't need to dispatch push notifications, any LLM context that gets persisted to disk uncontrolled, any GitHub repo, any third party.

**For future agents**: if a subagent needs to test APNs locally, give it the Key ID + Team ID + Bundle ID; have it use a TEST .p8 generated in App Store Connect (Apple lets you have up to 2 active APNs keys per team — keep the production one for prod and a separate one for dev/test).

## Backup procedure

1. Open `~/Downloads/AuthKey_M9WAFLNC2U.p8`
2. Copy the full content (5 lines, 257 bytes)
3. In 1Password: create a new Secure Note titled "HealthLog APNs Key M9WAFLNC2U"; paste content; add Key ID + Team ID + Bundle ID as additional fields
4. Mirror in a second password manager OR encrypted-offline backup (LUKS-encrypted USB, 1Password offline export, etc.)
5. **Then** move the .p8 from Downloads to a secured spot (e.g. `~/.apple-keys/AuthKey_M9WAFLNC2U.p8` with `chmod 400`) — don't leave it in Downloads where it could get cloud-synced

## Rotation procedure (when needed)

Rotate if:
- Key was leaked (real or suspected)
- Key is ≥ 12 months old (Apple recommends rotation every year)
- Marc's MacBook is lost or compromised

Steps:
1. Apple Developer Portal → Certificates, Identifiers & Profiles → Keys → New Key. Select APNs. Generate.
2. Download the new `.p8`. Note the new Key ID.
3. Backup the new `.p8` per §"Backup procedure" above.
4. Update apps01: Coolify env vars `APNS_KEY_ID`, `APNS_KEY` (replace both). Trigger redeploy.
5. Update edge-01: edit `/data/coolify/applications/ck8cs4osswg8w440gskw08w8/.env`. Recreate container.
6. Verify push delivery: test from iOS Simulator → server logs show `APNs sent OK`.
7. After verifying the new key works for 24-48 hours, revoke the OLD key in Apple Developer Portal.
8. Delete the OLD `.p8` from 1Password (or label as "revoked").

## Incident response — key leaked

1. **Immediately** revoke the key in Apple Developer Portal. This stops any push dispatch using it.
2. **Within minutes** — generate a new key + update both servers (per §Rotation above).
3. Notify users that a security event occurred (in-app banner + GitHub Discussions). Push notification delivery may be interrupted during the rotation.
4. Audit who/where the key was exposed; close the leak channel.
5. Update this doc with the incident timeline.

## Related references

- Apple APNs documentation: https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server
- Server APNs code: `src/lib/notifications/senders/apns.ts`
- Test fixtures (mock key, never the real one): `src/lib/notifications/senders/__tests__/apns.test.ts`
- iOS-side APNs registration: `/Users/marc/Projects/healthlog-iOS/HealthLogIOS/HealthLog/Services/NotificationService.swift` (and AppDelegate shim)
- Privacy policy reference to APNs: `/privacy` §4 (Apple Inc. → APNs)

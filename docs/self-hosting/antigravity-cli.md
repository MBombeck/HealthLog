# Antigravity CLI Deployment Guide

This guide covers deployment and configuration of the Antigravity CLI (`agy`) provider in HealthLog.

## Overview

Antigravity CLI is an optional AI provider that runs locally in the HealthLog container but sends data to Antigravity/Google services for processing.

**Key characteristics**:

- ✅ Runs locally in Docker container
- ✅ Support for images and PDFs (via text layer or page images fallback)
- ❌ No HealthLog function calling (`supportsTools = false`)
- ⚠️ External data processing (sends data to Antigravity/Google)
- ⚠️ Requires separate Antigravity account

## Prerequisites

1. **Antigravity Account**: You need an Antigravity account (account type depends on Antigravity's terms)
2. **Docker Host**: Linux amd64 or arm64 host
3. **Network Access**: Container must reach Antigravity services
4. **Single App Instance**: Antigravity operations require a single HealthLog app instance (see [Single Instance Requirement](#single-instance-requirement))

### Single Instance Requirement

HealthLog manages interactive OAuth login flows (`agy acp --login`) through child processes whose standard I/O streams and pending authentication states are kept in local Node.js process memory (`activeSessions` in `src/lib/ai/antigravity-auth-session.ts`). Additionally, runtime capability negotiation results are cached in a process-local memory cache (`antigravity-capability-cache.ts`).

Because interactive sessions and capability caches are process-local, **horizontal scaling (running multiple app replicas behind a round-robin load balancer) is not supported** for Antigravity operation. Deployments using the Antigravity CLI provider must run as a single application container instance.

## Installation

### Option 1: Installed by an administrator (Recommended)

The image does not contain `agy`. In-container installation is available from the
administrator panel only: an administrator installs it from HealthLog Settings →
AI → Antigravity with the "Install Antigravity CLI" button. Only an administrator
sees that button. Automatic installation at container startup is not supported.
The installation dynamically discovers the latest official release from GitHub
(falling back to the build-pinned version `AGY_PINNED_VERSION` with build-pinned hashes for a fresh install if discovery is unavailable),
strictly validates the official release URL, and verifies its platform SHA-256 digest
(retrieved from official GitHub release metadata over HTTPS) and binary version before placing it at `<ANTIGRAVITY_PROFILE_ROOT>/bin/agy`.
The administrator panel can also update an eligible HealthLog-managed binary to the latest
official release using atomic replacement after checksum and version verification.
Existing externally managed binaries remain operator-managed.

Verify installation:

```bash
docker compose exec app agy --version
```

### Option 2: External CLI

If you prefer to manage the CLI separately:

1. Install `agy` on the Docker host following [Antigravity CLI installation guide](https://antigravity.google/docs/cli/installation/)
2. Mount the binary into the container:
   ```yaml
   services:
     app:
       volumes:
         - /usr/local/bin/agy:/usr/local/bin/agy:ro
   ```

## Configuration

### 1. Profile Directory Persistence (Default Named Volume)

By default, `docker-compose.yml` mounts a dedicated named volume `antigravity-profiles` to `/var/lib/healthlog/antigravity`:

```yaml
# docker-compose.yml
services:
  app:
    volumes:
      - backups:/var/lib/healthlog/backups
      - antigravity-profiles:/var/lib/healthlog/antigravity
    environment:
      ANTIGRAVITY_PROFILE_ROOT: /var/lib/healthlog/antigravity

volumes:
  postgres-data:
  pgdata:
  backups:
  antigravity-profiles:
```

This persistent volume retains:

- **Per-user OAuth tokens**: Each authenticated user gets an isolated subdirectory under `/var/lib/healthlog/antigravity/<profile-id>`.
- **Admin-installed binary**: When installed via the admin panel, `agy` is stored at `/var/lib/healthlog/antigravity/bin/agy`.

Both user OAuth tokens and the installed binary persist across container restarts and image recreations (`docker compose down && docker compose up -d`).

#### Migration Notes for Existing Deployments

If an existing deployment was created before the named volume was enabled by default, its Antigravity profiles and admin-installed binary were stored directly in the container's writable overlay layer.

When upgrading `docker-compose.yml` to the version with the persistent volume:

1. Docker will mount an empty named volume over `/var/lib/healthlog/antigravity`, hiding files previously stored in the container layer.
2. To preserve existing data without re-authenticating, operators can copy existing profile data before recreating the container:
   ```bash
   # Copy profiles from running container to host
   docker compose cp app:/var/lib/healthlog/antigravity ./agy-backup
   # After restarting with the new volume mount, copy back into the named volume
   docker compose cp ./agy-backup/. app:/var/lib/healthlog/antigravity/
   ```
   Alternatively, administrators can re-run "Install Antigravity CLI" in Settings → AI → Antigravity, and users can reconnect their accounts.
3. Do not modify running deployments or remote containers without a planned maintenance window.

### 2. Configure Environment Variable

Set `ANTIGRAVITY_PROFILE_ROOT` in your `.env` or docker-compose.yml:

```bash
# .env
ANTIGRAVITY_PROFILE_ROOT=/var/lib/healthlog/antigravity
```

Or directly in docker-compose.yml:

```yaml
services:
  app:
    environment:
      <<: *healthlog_env
      ANTIGRAVITY_PROFILE_ROOT: /var/lib/healthlog/antigravity
```

### 3. Authenticate Users

Each user must authenticate independently:

1. User opens HealthLog Settings → AI Providers → Antigravity
2. Click "Connect Antigravity"
3. HealthLog generates a profile ID and shows instructions
4. HealthLog starts the CLI's login on the server and shows a Google sign-in link
5. The user opens the link in their browser, signs in with Google, and pastes the authorization code into the HealthLog dialog
6. Submitting the code completes the authentication and verifies the connection and capabilities

Disconnecting removes the profile folder and its login. So does wiping the data
(Settings → Data, or the admin wipe). Account locking during the deletion grace
window also immediately removes the profile folder and OAuth login from disk to
ensure credentials do not outlive the account. If an account deletion is
subsequently undone, the account is restored without the CLI login; the user
must sign in again (relogin) in Settings → AI Providers → Antigravity. Connecting
again always needs a new sign-in.

The CLI process and profile folder reside on the host where HealthLog runs; the user completes the Google OAuth sign-in via their browser and pastes the authorization code into HealthLog's dialog.

Without `ANTIGRAVITY_PROFILE_ROOT` the provider stays off, because there is no per-user folder to isolate the login in.

8. Add "Antigravity CLI" to the fallback chain in Settings, AI. It is not on by default.

## Security Model

### Credential Storage

- **HealthLog Database**: Stores only the profile ID, the connection status and the last test result
- **CLI Credential Store**: Stores OAuth tokens independently (managed by `agy`)
- **Separation**: HealthLog never sees or stores OAuth tokens

### Profile Isolation

When `ANTIGRAVITY_PROFILE_ROOT` is configured:

- Each user gets a profile folder, `<root>/<profile-id>`. HealthLog passes the user profile directory as `--gemini-dir` to provide per-user CLI state and OAuth credential isolation. `--app-data-dir` is not used. Without per-user `--gemini-dir` the CLI would use `$HOME/.gemini`, which all users would share.
- The CLI also keeps a shared `<root>/config` folder. In a test run with agy 1.5.8 it held `config.json` and `mcp_config.json`. Review what it holds before relying on it.
- Separate `agy` process per call
- **Token retention**: The CLI stores the OAuth token at `<geminiDir>/antigravity-oauth-token`, within the user's profile directory. Because `--gemini-dir` points to the user's profile folder under `ANTIGRAVITY_PROFILE_ROOT`, the token is isolated per-user and preserved across container recreates when the profile root volume is mounted.

### Workspace Isolation

Every completion runs in:

- Empty temporary workspace (not the HealthLog codebase)
- Deleted after completion
- `--sandbox` flag enabled
- `mcpServers: []` (no external tool access)
- All permission requests rejected

### Data Flow

```
User Request → HealthLog → agy CLI → Antigravity/Google Services
                ↑              ↓
              DB ← Profile ID ← Profile Dir
```

HealthLog never sees:

- OAuth tokens
- API keys
- Prompt/response content (except for debugging)
- CLI stderr (drained without logging)

## Capabilities

### Supported

- ✅ **Images**: PNG, JPEG, WebP (via `promptCapabilities.image`)
- ✅ **PDFs**: Single and multi-page handled via text layer extraction or rendered page images fallback (`supportsPdfForProvider("antigravity")` is `false`; ACP wire has no native PDF block)
- ✅ **Models**: Discovered at runtime from ACP
- ✅ **Thinking Levels**: Model-specific reasoning depth

### Not Supported

- ❌ **Function Calling**: `supportsTools = false` permanently
- ❌ **Audio**: Not implemented
- ❌ **JSON Schema**: No native enforcement
- ❌ **Session Resume**: Each completion gets fresh session

### Clinical Document Extraction Limitations

When using the Antigravity provider for clinical document extraction (`antigravity-extract.ts`):

- **Analyte Label Anchoring Only**: Automated text anchoring (`anchorSourceText`) checks and anchors the **analyte label** against document text.
- **Unverified Numeric Values and Reference Ranges**: Extracted numeric values, qualitative values, units, and reference ranges are **not** verified against source document text by anchoring.
- **Human Review Required**: All staged clinical facts extracted via this path require explicit human review and clinical validation before acceptance into the permanent record.

## Monitoring

### Connection Status

Check status via HealthLog API:

```bash
curl -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/antigravity/status
```

Returns:

```json
{
  "cliInstalled": true,
  "cliVersion": "1.5.8",
  "profileId": "abc123...",
  "model": "gemini-2.0-flash-exp",
  "connectionStatus": "connected",
  "capabilities": {
    "image": true,
    "resourceBlob": true
  }
}
```

### Logs

**Do NOT log**:

- Full stderr output (may contain sensitive data)
- Prompt content
- Response content
- Attachment data

HealthLog logs only:

- Capability negotiation results
- Connection status changes
- Error codes (not messages)

## Troubleshooting

### CLI Not Found

**Symptom**: `cliInstalled: false`

**Solution**: An administrator installs through Settings → AI → Antigravity, or operators may mount their managed binary as described in Option 2.

### Authentication Required

**Symptom**: `connectionStatus: "auth_required"`

**Solution**: Run `agy acp --login` as described in Configuration section.

### Profile Isolation Issues

**Symptom**: Users see each other's data

**Cause**: `ANTIGRAVITY_PROFILE_ROOT` not configured

**Solution**:

1. Set `ANTIGRAVITY_PROFILE_ROOT` environment variable
2. Create volume mount as shown above
3. Restart container

### Permission Denied

**Symptom**: "Permission denied" on profile directory

**Solution**: Ensure directory ownership:

```bash
docker compose exec app chown -R nextjs:nodejs /var/lib/healthlog/antigravity
docker compose exec app chmod 755 /var/lib/healthlog/antigravity
```

### Malformed Profile IDs & Operator Repair

**Symptom**: Wipe or account deletion returns 500 with an `antigravity.profile.invalid_id` diagnostic.

**Cause**: A user row has a malformed `antigravityProfileId` containing illegal characters or path traversal elements. Safe profile IDs must be either standard 32-character hex or safe legacy alphanumeric identifiers (`^[A-Za-z0-9_-]{1,64}$`).

**Operator Recovery**:

1. Inspect the profile root (`/var/lib/healthlog/antigravity`) on the host to verify whether any directory or credentials exist for this user. **Never interpolate an unvalidated or malformed profile ID directly into a destructive path (`rm -rf ...`)**; always verify containment strictly within the profile root (no `..` or path traversal). Only delete the directory after confirming it resides directly within the root:
   ```bash
   cd /var/lib/healthlog/antigravity && ls -la
   # Confirm directory name matches the expected profile without traversal before removing:
   rm -rf -- ./<confirmed-profileId>
   ```
2. Only after verifying on the host that no credentials remain, repair the database pointer:

```sql
UPDATE "User"
SET "antigravityProfileId" = NULL,
    "antigravityConnectionStatus" = 'disconnected',
    "antigravityModel" = NULL
WHERE "id" = '<userId>';
```

3. Re-run the wipe or account deletion.

### Profile Cleanup Blocking Account Erasure

**Symptom**: Account purge or deletion fails with an error:
`Failed to remove Antigravity profile directory for user <userId>; aborting account erasure to preserve retry reference`.

**Cause**: Account deletion verifies that the on-disk profile folder and OAuth credentials are deleted before committing the deletion of the user row. If `ANTIGRAVITY_PROFILE_ROOT` is unset/invalid, directory permissions prevent `rm -rf`, or the filesystem is mounted read-only, erasure is aborted to prevent orphaned credentials on host disk. The database pointer is intentionally preserved so cleanup can be retried.

**Operator Recovery**:

> [!WARNING]
> Never clear the profile pointer in the database while credentials may remain on disk. Doing so abandons unmanaged OAuth tokens on the host. Always restore configuration or verify manual folder deletion before retrying.

1. **Restore volume or configuration (Preferred)**:
   - Ensure `ANTIGRAVITY_PROFILE_ROOT` is set to the valid absolute path and that the volume mount is active.
   - Fix filesystem permissions on the host directory:
     ```bash
     docker compose exec app chmod -R 700 /var/lib/healthlog/antigravity
     ```
2. **Or verified manual deletion on host**:
   - If the root path changed permanently or cannot be mounted, inspect the host filesystem and verify root containment before deleting (never interpolate unvalidated profile IDs into destructive commands):
     ```bash
     cd /var/lib/healthlog/antigravity && ls -la
     # Confirm directory name and remove safely within root:
     rm -rf -- ./<confirmed-profileId>
     ```
3. **Retry without manual SQL**:
   - Once the path is accessible or the directory is verified deleted on the host, retry the purge job or account deletion.
   - Because profile removal is idempotent (`rm -rf` succeeds when the directory no longer exists under a valid root), the cleanup check will succeed and account erasure will complete cleanly without manual SQL edits.

## Resource Limits

### Process Limits

Each `agy` process:

- **Timeout**: Default 60 seconds (configurable per request)
- **Memory**: Shares container memory limit
- **Concurrency**: One process per active completion

### Profile Storage

- **Per-profile**: Varies with usage (typically < 10 MB for credentials)
- **Cleanup**: Manual (profiles persist until explicitly deleted)

## Legal Considerations

⚠️ **Important**: Antigravity CLI sends data to external services operated by Google/Antigravity. Review their terms of service:

- [Antigravity Terms of Service](https://antigravity.google/terms)
- [Antigravity Privacy Policy](https://antigravity.google/privacy)
- [Antigravity CLI Documentation](https://antigravity.google/docs/cli/)

**HealthLog does NOT**:

- Control data retention by Antigravity
- Verify data handling practices
- Assume liability for external processing

**User responsibility**:

- Verify compliance with local regulations
- Review Antigravity terms before enabling
- Inform end users about external data processing

## Upgrade Path

### Updating CLI Version

HealthLog automatically discovers new stable releases of the Antigravity CLI from the official repository:
[Google Antigravity CLI releases](https://github.com/google-antigravity/antigravity-cli/releases).

When a newer official release is available:

1. An administrator navigates to Settings → AI → Antigravity.
2. If an update is available for an eligible HealthLog-managed binary, an "Update Antigravity CLI" button is displayed.
3. Clicking "Update Antigravity CLI" performs latest-release discovery from GitHub, strictly verifies the official release URL in `src/lib/ai/antigravity-release.ts` (`parseAntigravityRelease`) and `src/lib/ai/antigravity-install-core.mjs`, verifies downloaded archive bytes against the official GitHub release metadata SHA-256 digest over HTTPS (not an out-of-band or hard-coded pinned hash), verifies the extracted binary `--version`, and replaces the managed binary atomically.
4. If GitHub discovery is unreachable or rate-limited during initial installation, HealthLog falls back to installing the default pinned version (`AGY_PINNED_VERSION` in `src/lib/ai/antigravity-install-core.mjs`).
5. Externally managed binaries (e.g. mounted from the host) cannot be updated via the admin panel and remain operator-managed.

### Installer Trust Model & Binary Verification

When installing or updating the CLI via HealthLog:

- **Symlink & Non-Regular File Rejection**: The installer inspects the extracted file using `lstat` before applying execution permissions (`chmod 0o755`) and before moving it into place (`rename`). Symbolic links and non-regular files (such as sockets, FIFOs, and directories) are strictly rejected with an error (`"Extracted antigravity binary must be a regular file"`).
- **Checksum Verification**:
  - **Pinned Base Version**: When installing the build-pinned version (`AGY_PINNED_VERSION` = 1.5.10), the installer strictly enforces the hardcoded SHA-256 digest (`AGY_SHA256_AMD64` or `AGY_SHA256_ARM64`).
  - **Dynamic Releases**: When an administrator updates to a newer release discovered via GitHub releases, HealthLog strictly validates that the asset download URL belongs to `github.com/google-antigravity/antigravity-cli` over HTTPS (enforced in `src/lib/ai/antigravity-release.ts` and `src/lib/ai/antigravity-install-core.mjs`), retrieves the release asset SHA-256 digest published in official GitHub release metadata over HTTPS, and validates the downloaded archive against this digest before extraction.

### No Automatic Updates

HealthLog does **NOT** auto-update the CLI in the background, and automatic installation at container startup is unsupported. An administrator initiates updates through the admin panel; existing externally managed binaries remain operator-managed.

## Further Reading

- [Antigravity CLI Architecture](../antigravity-cli-architecture.md)
- [Antigravity Multimodal Support](../antigravity-cli-multimodal.md)
- [Antigravity Transport Decision](../antigravity-cli-transport-decision.md)
- [Integration Plan](../../.local/antigravity-cli-integration-plan.md)

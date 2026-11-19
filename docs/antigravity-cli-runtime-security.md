# Antigravity CLI Runtime Security

**Status**: Stage 5 Complete
**Date**: 2026-11-13

---

## Overview

This document describes the runtime security model for the Antigravity CLI provider in HealthLog.

---

## Docker Configuration

### CLI Installation and Updates

The container image does not include `agy`. In-container installation and updates are available exclusively through the administrator panel:

- **Image does not include `agy`**: The base container image ships without the CLI binary pre-installed.
- **Admin-only installation and updates**: Only an administrator can install or update an eligible HealthLog-managed CLI via Settings → AI → Antigravity to the latest official release. A fresh installation falls back to `AGY_PINNED_VERSION` if GitHub discovery is unavailable; updates and repairs require a discovered release to avoid downgrading an existing binary.
- **Official release validation and verified download**: Downloads strictly validate the official `google-antigravity/antigravity-cli` GitHub release URL and tag, and verify the platform SHA-256 checksum and extracted binary version before installation and atomic replacement.
  - _Trust boundary_: For dynamic updates and online installs, the SHA-256 digest is retrieved from official GitHub release metadata over HTTPS and verifies downloaded asset bytes against that metadata, rather than an independently signed or out-of-band detached cryptographic checksum. Hard-coded pinned hashes (`AGY_SHA256_AMD64`, `AGY_SHA256_ARM64`) apply only to the offline fallback pinned version (`AGY_PINNED_VERSION`), not to dynamic updates to newer releases.
- **Profile root storage**: The managed binary is stored under the configured profile root (`<ANTIGRAVITY_PROFILE_ROOT>/bin/agy`).
- **Externally managed binary**: An externally managed binary (e.g. mounted from the host, system-installed, or configured via `ANTIGRAVITY_BIN_PATH`) remains operator-managed and cannot be updated from the admin panel.

### Volume Configuration

**File**: `docker-compose.yml`

**Profile directory**:

```yaml
services:
  app:
    volumes:
      - antigravity-profiles:/var/lib/healthlog/antigravity
    environment:
      ANTIGRAVITY_PROFILE_ROOT: /var/lib/healthlog/antigravity

volumes:
  antigravity-profiles:
```

**Security properties**:

- ✅ Isolated volume (never entire `/home`)
- ✅ User-owned directory (`nextjs:nodejs`, mode 755)
- ✅ Optional (single-user deploys can skip)
- ✅ No privileged mode
- ✅ No Docker socket access

---

## Runtime Isolation

### Process Isolation

**File**: `src/lib/ai/antigravity-client.ts`

Each completion spawns an isolated process:

```typescript
const args = [
  "acp",
  "--sandbox",
  "--disable-telemetry",
  "--gemini-dir",
  profile.geminiDir, // ANTIGRAVITY_PROFILE_ROOT (absolute)
  "--app-data-dir",
  profile.appDataDir, // profile id (relative name)
];

const connection = await AcpConnection.start(args, {
  cwd: workDir, // Empty temporary directory
  env: antigravityChildEnv(), // Allowlisted environment only
});
```

**Isolation properties**:

1. **Workspace**: Fresh `mkdtempSync()` directory per request
2. **Environment**: Only allowlisted vars (`PATH`, `HOME`, `LANG`, etc.)
3. **Sandbox**: `--sandbox` flag enabled
4. **Telemetry**: `--disable-telemetry` (doesn't disable Interactions)
5. **Profile**: `--gemini-dir` set to the user's profile directory (`<root>/<profile-id>`) ensuring per-user CLI state and OAuth token isolation (`<geminiDir>/antigravity-oauth-token`). `--app-data-dir` is not used.

### Environment Allowlist

```typescript
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
] as const;
```

**Excluded**:

- ❌ `ANTHROPIC_API_KEY`
- ❌ `OPENAI_API_KEY`
- ❌ `DATABASE_URL`
- ❌ `ENCRYPTION_KEY`
- ❌ All other app secrets

### Permission Model

**All permission requests rejected**:

```typescript
private onAgentRequest(
  id: number | string,
  method: string,
  params: unknown,
): void {
  if (method === "session/request_permission") {
    const options =
      (params as { options?: AcpPermissionOption[] } | undefined)?.options ?? [];
    const reject = options.find((o) => o.kind === "reject_once");
    const outcome = reject
      ? { outcome: "selected", optionId: reject.optionId }
      : { outcome: "cancelled" };
    this.write({ jsonrpc: "2.0", id, result: { outcome } });
    return;
  }
}
```

**No exceptions**:

- ❌ No "read-only" file access
- ❌ No terminal commands
- ❌ No network operations
- ❌ No MCP server connections

### Process Lifecycle

```typescript
try {
  return await Promise.race([
    this.execute(workDir, blocks, params, onDelta, state),
    cancelled,
  ]);
} finally {
  state.done = true;
  if (onAbort) signal?.removeEventListener("abort", onAbort);
  await state.connection?.close(); // SIGTERM, then SIGKILL
  rmSync(workDir, { recursive: true, force: true }); // Cleanup workspace
}
```

**Cleanup guarantees**:

1. Session closed
2. Process terminated (SIGTERM → SIGKILL after 2s grace)
3. Workspace deleted
4. No zombie processes (wait for exit)

---

## Data Handling

### What HealthLog Sends

**Via ACP**:

- System instructions
- User messages
- Images (Base64)
- PDFs (Base64 blob, never file paths)

**Never sends**:

- ❌ File paths (`@file` syntax NOT used)
- ❌ Local files
- ❌ Database content
- ❌ Other users' data

### What HealthLog Logs

**Never logged**:

- ❌ Full stderr output (may contain sensitive data)
- ❌ Prompt content
- ❌ Response content
- ❌ Attachment data
- ❌ ACP session IDs

**Logged**:

- ✅ Capability negotiation results
- ✅ Connection status changes
- ✅ Error codes (stable codes, not messages)

```typescript
// stderr can carry user data or secrets. Drain it and never log it.
child.stderr?.resume();
```

### Data Flow

```
User → HealthLog → ACP (JSON-RPC) → agy CLI → Antigravity/Google
                     ↓
              Temp workspace (deleted)
```

**No persistence**:

- Temp workspace: Deleted after completion
- Session IDs: Never stored in DB
- Credentials: Managed by CLI, not HealthLog

---

## Resource Limits

### Timeout Management

**Setup timeout**: 30 seconds (initialize + session/new)
**Prompt timeout**: 60 seconds default (configurable per request)
**Kill grace**: 2 seconds (SIGTERM → SIGKILL)

```typescript
const SETUP_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 2_000;
```

### Memory Limits

**Buffer limit**: 16 MB per JSON-RPC message

```typescript
const MAX_BUFFER_CHARS = 16 * 1024 * 1024;
```

Prevents runaway agent from exhausting memory.

### Concurrency

**Pattern**: One process per completion, no session reuse

```typescript
// New process and session for each completion
const workDir = mkdtempSync(join(tmpdir(), "healthlog-acp-"));
```

**No contention**: Profile-level isolation prevents user conflicts

---

## Security Checklist

### ✅ Workspace Security

- [x] Empty temporary workspace per request
- [x] Workspace deleted in `finally` block
- [x] Never HealthLog codebase directory
- [x] No file persistence between requests

### ✅ Process Security

- [x] `spawn` with `shell: false`
- [x] Allowlisted environment only
- [x] `--sandbox` flag enabled
- [x] `mcpServers: []` (no MCP)
- [x] No filesystem client capabilities
- [x] No terminal client capabilities

### ✅ Permission Security

- [x] All `session/request_permission` rejected
- [x] No "read-only" exceptions
- [x] No tool execution
- [x] No command execution

### ✅ Profile Isolation

- [x] Optional `ANTIGRAVITY_PROFILE_ROOT`
- [x] Separate `--app-data-dir` per user
- [x] No shared credentials between users
- [x] Profile ID is opaque identifier (not a path)

### ✅ Data Security

- [x] No OAuth tokens in database
- [x] No logging of stderr
- [x] No logging of prompts/responses
- [x] Base64 only (no file paths)
- [x] No persistent sessions

### ✅ Resource Security

- [x] Process timeout enforced
- [x] Message size limits
- [x] Proper cleanup on abort/error
- [x] No zombie processes

### ✅ Docker Security

- [x] No privileged mode
- [x] No Docker socket access
- [x] `cap_drop: ALL`
- [x] `no-new-privileges`
- [x] User-owned profile directory

---

## Prompt Injection Mitigation

### Threat Model

Malicious document attempts to:

1. Read `.env` file
2. Access database
3. Access other profiles
4. Execute commands
5. Exfiltrate data

### Mitigations

**Workspace isolation**:

- Empty temp directory: nothing to read
- No access to HealthLog codebase
- No database connection

**Permission rejection**:

- No file read permission
- No command execution
- No network access

**Environment isolation**:

- No credentials in environment
- No database URL
- No encryption keys

**Process isolation**:

- Separate process per request
- No shared state
- No session resume

**Result**: Document content cannot affect execution environment.

---

## Comparison with Other Providers

| Property            | Anthropic/OpenAI | Codex           | Antigravity       |
| ------------------- | ---------------- | --------------- | ----------------- |
| Process isolation   | N/A (API)        | N/A (API)       | ✅ Per completion |
| Workspace isolation | N/A              | N/A             | ✅ Temp directory |
| Permission model    | N/A              | N/A             | ✅ Reject all     |
| Credential storage  | Encrypted in DB  | Encrypted in DB | CLI-managed       |
| Function calling    | ✅ Yes           | ✅ Yes          | ❌ No             |
| Image support       | ✅ Yes           | ✅ Yes          | ✅ Yes            |
| PDF support         | ✅ Native        | ❌ Raster only  | ✅ Native         |

---

## Deployment Checklist

### Before Enabling Antigravity

1. **Review legal**:
   - [ ] Read Antigravity terms of service
   - [ ] Verify compliance with local regulations
   - [ ] Inform users about external processing

2. **Configure Docker**:
   - [ ] Verify `agy --version` in container
   - [ ] Set `ANTIGRAVITY_PROFILE_ROOT` (multi-user)
   - [ ] Create profile volume (multi-user)

3. **Test authentication**:
   - [ ] Run `agy acp --login` manually
   - [ ] Verify connection status
   - [ ] Test with synthetic data

4. **Monitor**:
   - [ ] Check connection status endpoint
   - [ ] Review logs (error codes only)
   - [ ] Verify no sensitive data in logs

### Ongoing Operations

- **No auto-updates**: Manually update CLI version
- **No auto-logout**: Users manage their own sessions
- **Profile cleanup**: Manual (no automatic deletion)
- **Log review**: Verify no sensitive data leakage

---

## References

- [Antigravity CLI Deployment Guide](./self-hosting/antigravity-cli.md)
- [Antigravity Architecture](./antigravity-cli-architecture.md)
- [Antigravity Multimodal Support](./antigravity-cli-multimodal.md)
- [Integration Plan](../.local/antigravity-cli-integration-plan.md)

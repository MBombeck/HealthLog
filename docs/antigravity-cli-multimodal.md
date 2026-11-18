# Antigravity CLI Multimodal Support

**Status**: Stage 3 Complete
**Date**: 2026-11-13

---

## Overview

Antigravity CLI (`agy acp`) supports multimodal input through ACP v1 content blocks:

- **Images**: PNG, JPEG, WebP via `image` content blocks
- **PDFs**: via `resource` content blocks with embedded blob data

This document describes the implementation and verification of multimodal support in HealthLog.

---

## Image Support

### ACP Protocol

Images are sent as content blocks in `session/prompt`:

```json
{
  "type": "image",
  "mimeType": "image/png",
  "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB..."
}
```

**Requirements**:

- `mimeType` field (required): One of `image/png`, `image/jpeg`, `image/webp`
- `data` field (required): Base64-encoded image bytes (no data URL prefix)
- `uri` field (optional): URI reference (not used in HealthLog)

### Capability Discovery

The `initialize` response includes `promptCapabilities`:

```json
{
  "capabilities": {
    "promptCapabilities": {
      "image": true
    }
  }
}
```

HealthLog checks this capability before attempting to send images. If `image` is `false` or `undefined`, the client throws an error before spawning the process.

### Implementation

**File**: `src/lib/ai/antigravity-client.ts:444-449`

```typescript
if (part.type === "image") {
  blocks.push({
    type: "image",
    mimeType: part.mediaType,
    data: part.dataBase64,
  });
}
```

**Capability Check**: Lines 609-614

```typescript
if (blocks.some((b) => b.type === "image") && promptCaps.image !== true) {
  throw new AntigravityError(
    "Antigravity does not accept image input",
    ANTIGRAVITY_ERRORS.PROMPT_FAILED,
  );
}
```

### Supported Formats

- ✅ PNG (`image/png`)
- ✅ JPEG (`image/jpeg`)
- ✅ WebP (`image/webp`)
- ⚠️ Other formats: ACP may reject; validate upstream

---

## PDF Support

### ACP Protocol

PDFs are sent as `resource` blocks with embedded blob data:

```json
{
  "type": "resource",
  "resource": {
    "uri": "healthlog://attachment-1.pdf",
    "mimeType": "application/pdf",
    "blob": "JVBERi0xLjQKJeLjz9MKMSAwIG9iago..."
  }
}
```

**Requirements**:

- `uri` field (required): Unique identifier (HealthLog uses `healthlog://attachment-N.pdf`)
- `mimeType` field (required): `application/pdf`
- `blob` field (required): Base64-encoded PDF bytes

### Capability Discovery

PDF support is indicated by `promptCapabilities.resourceBlob`:

```json
{
  "capabilities": {
    "promptCapabilities": {
      "resourceBlob": true
    }
  }
}
```

### Implementation

**File**: `src/lib/ai/antigravity-client.ts:450-461`

```typescript
else if (part.type === "document") {
  documents += 1;
  blocks.push({
    type: "resource",
    resource: {
      uri: `healthlog://attachment-${documents}.pdf`,
      mimeType: part.mediaType,
      blob: part.dataBase64,
    },
  });
}
```

**Capability Check**: Lines 615-623

```typescript
if (
  blocks.some((b) => b.type === "resource") &&
  promptCaps.resourceBlob !== true
) {
  throw new AntigravityError(
    "Antigravity does not accept PDF input",
    ANTIGRAVITY_ERRORS.PROMPT_FAILED,
  );
}
```

### Multi-page PDFs

Antigravity receives the complete PDF byte stream. Multi-page handling is the responsibility of the underlying model. HealthLog does NOT:

- Split pages before sending
- Rasterize pages unless native PDF is unavailable
- Impose page limits at the transport level (upstream document processing handles this)

### Fallback Strategy

If `promptCapabilities.resourceBlob` is `false`:

1. HealthLog rejects the PDF before spawning the process
2. User receives clear error message
3. Alternative: Use image upload instead

This differs from Anthropic's native PDF support, which is always available for compatible Claude models.

---

## Vision Capability Integration

### File: `src/lib/ai/vision-capability.ts`

#### Image Support

```typescript
case "antigravity":
  // Stage 3: Image support confirmed via ACP promptCapabilities.image
  // PDF native support depends on runtime discovery of promptCapabilities.resourceBlob
  // This is a conservative capability gate; actual processing verified at runtime.
  return true;
```

**Rationale**: Optimistically return `true` because capability is verified at runtime. This allows Antigravity to be selected for vision-capable chains.

#### PDF Support

```typescript
export function supportsPdfForProvider(
  providerType: VisionProviderType,
): boolean {
  return providerType === "anthropic" || providerType === "antigravity";
}
```

**Rationale**: Antigravity is added to the PDF-capable provider list. Runtime capability check prevents false positives.

---

## Testing

### Unit Tests

**File**: `src/lib/ai/__tests__/antigravity-multimodal.test.ts`

Test coverage:

- ✅ Image acceptance when `promptCapabilities.image === true`
- ✅ Image rejection when `promptCapabilities.image === false` or `undefined`
- ✅ PDF acceptance when `promptCapabilities.resourceBlob === true`
- ✅ PDF rejection when `promptCapabilities.resourceBlob === false` or `undefined`
- ✅ JPEG and WebP image formats
- ✅ Multi-page PDF documents
- ✅ Combined text + image + PDF messages
- ✅ Capability discovery during `initialize`
- ✅ Undefined capabilities handling

### Integration Tests

Live tests with synthetic data only (opt-in, not in default `pnpm test`):

```bash
# Requires AGY account and explicit user consent
pnpm test:antigravity-live
```

**Fixtures**: `tests/fixtures/antigravity/documents/`

- All synthetic, NO real medical data
- Covers single/multi-page, scanned, lab results, damaged docs

---

## Known Limitations

### 1. No Function Calling

- ACP tools are for agent operations, not HealthLog function calling
- `supportsTools = false` permanently
- Coach switches to no-tools mode when Antigravity is in chain

### 2. No JSON Schema Enforcement

- ACP does not support `--json-schema`
- HealthLog uses prompt instructions + post-validation
- No native response format forcing

### 3. PDF Reliability

- Native PDF support depends on `resourceBlob` capability
- Some models may not correctly read all pages
- Fallback: User uploads photos of pages instead

### 4. Audio Not Supported

- Not implemented in Stage 3
- Not a health log priority use case

### 5. Capability Timing

- `capabilities` may be `undefined` in `initialize` response
- Fallback: Check during first `session/prompt`
- Alternative: Query `configOptions` after `session/new`

---

## Security Considerations

### 1. No Filesystem Access

Images and PDFs are embedded in the JSON-RPC message:

- No temporary files created
- No local paths exposed
- `@file` references NOT used

### 2. Workspace Isolation

Each completion runs in:

- Empty temporary directory (`mkdtempSync`)
- Deleted after completion (`rmSync`)
- No access to HealthLog codebase

### 3. Permission Rejection

All `session/request_permission` calls are rejected:

- Read/write permission requests denied
- Terminal command requests denied
- No exceptions

### 4. Data Flow

- Base64 data stays in memory
- Not logged (stderr drained without logging)
- No caching in HealthLog
- Process isolated from other users' profiles

---

## Performance Considerations

### Base64 Overhead

- ~33% size increase for binary data
- Memory overhead during transmission
- Large PDFs (>20 pages) may hit limits

### Timeout Handling

- Default prompt timeout: 60 seconds
- Multi-page PDFs may need longer
- Configurable via `timeoutMs` parameter

### Concurrency

- One process per completion
- No session reuse across requests
- Profile-level isolation prevents contention

---

## Future Enhancements

Potential post-PR improvements:

1. **Adaptive Timeout**: Adjust based on document size
2. **Progressive Streaming**: Stream PDF pages progressively
3. **Capability Caching**: Cache `promptCapabilities` per profile
4. **OCR Fallback**: Automatic rasterization if native PDF fails
5. **Audio Support**: If `promptCapabilities.audio` appears

---

## References

- ACP v1 Content Specification: https://agentclientprotocol.com/protocol/v1/content
- HealthLog Provider Architecture: `docs/antigravity-cli-architecture.md`
- Transport Decision: `docs/antigravity-cli-transport-decision.md`

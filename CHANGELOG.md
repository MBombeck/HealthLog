# Changelog

## [1.2.0] — 2026-04-18

### Added — Personalization, Glucose & Multi-Provider AI

- **Per-user custom thresholds**: Override the computed default ranges (BP, BMI, glucose, pulse) with values from your clinician. Audit-logged with previous/new values and timestamps. Doctor Report PDF flags custom ranges and prints both your target and the standard guideline value.
- **Blood glucose tracking**: New metric with `fasting`, `postprandial`, `random`, and `bedtime` contexts. Display unit switch between mg/dL and mmol/L (lossless conversion). Context-aware classification per ADA 2024 / DGIM. Per-context charting on dashboard and Doctor Report PDF.
- **Dashboard customization**: Show/hide and drag-to-reorder every dashboard widget. Per-user preference, reset-to-defaults button. Layout persists across the same user on the same device.
- **Built-in feedback system**: New in-app Send Feedback flow (Bug / Feature / Question / Other) with anonymized system info attachment. Stored in HealthLog's own database — no GitHub config required. Optional `Escalate to GitHub` button for admins who configure a PAT.
- **Multi-provider AI insights**: Provider abstraction extended with **Anthropic Claude** and **local OpenAI-compatible endpoints** (Ollama, LM Studio, vLLM, LiteLLM) alongside OpenAI. Per-user provider selection. Local endpoints keep all health data on your network.
- **Locale-aware UI polish (English-first)**: Numbers, dates, glucose units, BP, weight, and BMI all formatted via `useFormatters()` from the active locale. Doctor Report PDF and AI insight prompts now respect locale end-to-end (no hand-rolled `Intl.*` with fixed locales).

### Changed

- Reference range computation extracted into a dedicated `src/lib/health/thresholds.ts` module with computed defaults and override resolution.
- AI provider routing reworked to dispatch by `provider` field on the user record; OpenAI remains the default for legacy users.
- Dashboard route renders widgets from `UserDashboardLayout` model when present, otherwise falls back to the default order.
- Doctor Report PDF: locale-aware headers, glucose section, custom-range badges.

### Security

- GitHub PAT for feedback escalation stored AES-256-GCM encrypted in the database (never as env var).
- Local AI endpoint URLs validated against SSRF (no localhost/RFC1918 unless explicitly allowed by admin).
- Custom threshold writes rate-limited and audit-logged with IP.

## [1.1.0] — 2026-04-06

### Added — AI Insights Overhaul

- **ChatGPT Proxy Integration**: Insights now run through a local openai-oauth proxy using your ChatGPT subscription — no separate API billing required
- **Admin AI Fallback**: Admins can configure a global API key (OpenAI/OpenRouter) as fallback for users without their own connection
- **Provider Abstraction**: New `src/lib/ai/` module with pluggable providers (Codex OAuth, Admin Key, None) and automatic failover
- **Medical Insight Prompts**: 7 specialized prompts based on ESC/ESH 2023, WHO, DGE, and DEGAM guidelines
  - Blood Pressure: ESC/ESH classification, morning risk ladder (J-HOP), pulse pressure, seasonal variation
  - Weight: 5%/10% milestone recognition, plateau detection, body composition divergence
  - Pulse: Fitness interpretation ladder, 80-100 bpm elevated-risk band, rate-pressure product
  - BMI: Age-adjusted DEGAM classification for 65+
  - Medication Compliance: Chronotherapy hints, mood-adherence risk prediction, 90-day tracking
  - General Status: Cross-domain synthesis with cardiovascular risk stratification
  - Mood: Bidirectional correlations with vitals and adherence
- **Enriched Feature Extraction**:
  - Sleep duration and activity steps (previously ignored)
  - Rate-Pressure Product (pulse × systolic BP, myocardial demand indicator)
  - Body composition divergence flag (weight stable + body fat rising)
  - Mood-adherence risk predictor
  - Seasonal BP variation (winter vs summer, requires >180 days data)
  - BP standard deviation (sdSys30/sdDia30) as variability risk marker
  - Pulse pressure (arterial stiffness marker)
  - 5 cross-metric Pearson correlations (weight↔BP, pulse↔BP, mood↔pulse, mood↔BP, mood↔weight)
  - 90-day averages and all-time statistics for all metrics
  - Historical comparison (current 7d vs previous 30d baseline)
- **New UI Components**:
  - `InsightStatusCard`: Compact per-metric status card with classification indicator and fade-in animation
  - `InsightAdvisorCard`: Premium structured card with findings, correlations, recommendations (ready for integration)
- **OAuth Routes**: `/api/auth/codex/authorize`, `/callback`, `/disconnect` for ChatGPT connection
- **Admin AI Settings**: `/api/admin/ai-settings` for global API key management

### Changed

- Insight prompts now use personal advisor tone ("dein Blutdruck") with positive-first pattern
- Reasoning scaffold in system prompt (What changed? → Why? → What to do?)
- Conditional correlation instructions (only mention when |r| > 0.4)
- InsightResult schema enriched with `insightType`, `primaryRecommendation`, `classificationLabel`
- BP target calculation now uses paired readings (both sys AND dia must be in range simultaneously)
- Medication streak tracking extended from 7-day to 30-day window
- CSP updated to allow `chatgpt.com` for OAuth flow

### Security

- Rate limiting on all OAuth and admin endpoints
- PKCE (S256) + state parameter for OAuth CSRF protection
- Encrypted token storage at rest (AES-256-GCM)
- Error messages truncated to prevent upstream response body leaks
- Admin key preview shows last 4 chars of decrypted key (not ciphertext prefix)
- `prefers-reduced-motion` support for insight card animations

### Removed

- `openaiKeyEncrypted` field from User model (replaced by provider abstraction)
- Direct OpenAI API calls from insight generators (now routed through provider)
- Legacy API key input in settings UI (replaced by ChatGPT connect button)

## [1.0.1] — Previous release

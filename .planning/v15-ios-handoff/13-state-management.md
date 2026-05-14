---
file: 13-state-management.md
purpose: TanStack Query conventions on the web side plus the iOS data-layer mirror so the native app reuses the same cache contracts without poisoning state.
when_to_read: Before wiring any iOS network call, designing an iOS data store, or porting a mutation. Re-read when a screen looks "stale" or a cache invalidation isn't propagating.
prerequisites: 02-server-architecture.md, 12-design-system.md
estimated_tokens: 4400
version_anchor: v1.4.25 / sha 49f71c92
---

# State Management — Cache Keys, Unwrap Pattern, Streaming

## TL;DR

Every web query goes through `queryKeys.*` factories so a typo cannot silently poison the cache. Responses are always unwrapped via `(await res.json()).data`. Mutations invalidate every read query that touches the resource. iOS should mirror this with a typed `CacheKey` enum, an `APIEnvelope<T>` decoder, and a `CacheInvalidator` that maps mutation → keys-to-evict.

---

## 1. The One Rule You Cannot Break

> Same `queryKey` + different `queryFn` unwrap shape = silent cache poisoning.

This is Marc's hard-earned rule (memory: `feedback_react_query_key_collision`). Two `useQuery` calls keyed `["medications"]` where one returns `{ data: Medication[] }.data` and another returns the envelope itself will mutate each other's cache on focus refresh. The user sees the medications page flicker between a list and an object literal.

Defensive convention:

1. Every query key comes from `src/lib/query-keys.ts` — no inline string arrays.
2. Every query function does `const json = await res.json(); return json.data as T;`.
3. The factory return type is `as const` so two keys cannot collide structurally without TypeScript noticing.

iOS analogue:

```swift
// from .planning/v15-ios-handoff/13-state-management.md (concept)
enum CacheKey: Hashable {
    case auth
    case me
    case analytics
    case dashboardWidgets
    case medications
    case medicationDetail(String)
    case insightsComprehensive
    case insightsBpStatus(locale: String)
    // …
}

struct APIEnvelope<T: Decodable>: Decodable {
    let data: T
    let error: APIError?
    let meta: APIMeta?
}
```

The Swift `Hashable` enum makes structural collisions impossible — `medicationDetail("abc")` and `medicationDetail("def")` are distinct values; you can't accidentally write `.medications` when you meant `.medicationDetail(id)`.

---

## 2. The `queryKeys` Factory (canonical list)

```ts
// from src/lib/query-keys.ts — selected highlights
auth()                          → ["auth"]
authRegistrationStatus()        → ["auth", "registration-status"]

measurements()                  → ["measurements"]
moodEntries()                   → ["mood-entries"]

analytics()                     → ["analytics"]
moodAnalytics()                 → ["mood-analytics"]

insightsRoot()                  → ["insights"]
insightsComprehensive()         → ["insights", "comprehensive"]
insightsTargets()               → ["insights", "targets"]
insightsAdvisor()               → ["insights", "advisor"]
insightsBpStatus(locale)        → ["insights", "blood-pressure-status", locale]
insightsWeightStatus(locale)    → ["insights", "weight-status", locale]
insightsPulseStatus(locale)     → ["insights", "pulse-status", locale]
insightsBmiStatus(locale)       → ["insights", "bmi-status", locale]
insightsMoodStatus(locale)      → ["insights", "mood-status", locale]
insightsMedicationComplianceStatus(locale)
                                → ["insights", "medication-compliance-status", locale]

medications()                   → ["medications"]
medicationDetail(id)            → ["medications", id]
medicationComplianceChart(id)   → ["compliance-chart-inline", id]
medicationPhaseConfig(id)       → ["phase-config", id]
medicationIntakeSummary()       → ["medications", "intake-summary"]

dashboardWidgets()              → ["user", "dashboardWidgets"]
dashboardGlp1()                 → ["dashboard", "glp1"]

sourcePriority()                → ["auth", "source-priority"]

gamificationAchievements()      → ["gamification", "achievements"]
notificationsPreferences()      → ["notifications", "preferences"]
adminSettings() / adminStatus() / adminUsers() / adminTokens() / adminAuditLog(filter)
tokens() / telegram() / telegramSettings() / withings()
```

Locale is part of the key for per-locale-cached endpoints (every `*-status` route). Switching language invalidates only the matching locale variant; existing English text stays warm.

---

## 3. The Envelope Contract

Every API route in the project wraps its payload:

```json
{
  "data": { … the actual thing … },
  "error": null,
  "meta": { "requestId": "…", "version": "1.4.25" }
}
```

On error:

```json
{
  "data": null,
  "error": { "code": "RATE_LIMITED", "message": "…", "details": {…} },
  "meta": { … }
}
```

### Web side

```ts
// from src/app/page.tsx:201-209
const { data } = useQuery({
  queryKey: queryKeys.analytics(),
  queryFn: async () => {
    const res = await fetch("/api/analytics");
    if (!res.ok) throw new Error("Failed");
    const json = await res.json();
    return json.data as AnalyticsData;        // ← single-step unwrap
  },
  enabled: isAuthenticated,
});
```

### iOS side — exact mirror

```swift
func fetchEnvelope<T: Decodable>(
    _ url: URL, as type: T.Type
) async throws -> T {
    let (data, response) = try await session.data(from: url)
    guard let http = response as? HTTPURLResponse, http.statusCode < 400 else {
        throw APIError.from(data: data, status: (response as? HTTPURLResponse)?.statusCode)
    }
    let envelope = try JSONDecoder.healthLog.decode(APIEnvelope<T>.self, from: data)
    return envelope.data
}
```

No iOS call site should ever decode the envelope manually. Centralising it in `fetchEnvelope` makes "what does `data` mean" unambiguous and gives one place to bolt on `requestId` logging or `meta.version` mismatch warnings.

---

## 4. Cache Invalidation Pattern

> A mutation invalidates every read query that touches the resource.

The web app gets this wrong if a mutation only invalidates its own list. The dashboard depends on the same data through `analytics()`, so deleting a measurement must invalidate *both* `["measurements"]` and `["analytics"]`.

### Web side example

```ts
// conceptual — pattern shared across mutation hooks
const deleteMeasurement = useMutation({
  mutationFn: (id: string) => fetch(`/api/measurements/${id}`, { method: "DELETE" }),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.measurements() });
    queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
    queryClient.invalidateQueries({ queryKey: queryKeys.moodAnalytics() });
    queryClient.invalidateQueries({ queryKey: queryKeys.insightsComprehensive() });
  },
});
```

### Invalidation matrix

| Mutation | Invalidates |
|----------|-------------|
| `POST/PUT/DELETE /api/measurements` | `measurements()`, `analytics()`, `insightsRoot()` (prefix) |
| `POST/PUT/DELETE /api/mood-entries` | `moodEntries()`, `moodAnalytics()`, `analytics()`, `insightsRoot()` |
| `POST/PUT/DELETE /api/medications` | `medications()`, `medicationDetail(id)`, `medicationIntakeSummary()`, `dashboardGlp1()`, `analytics()` |
| `POST /api/medications/:id/intake` | same + `medicationComplianceChart(id)` |
| `POST /api/insights/generate` | `insightsAdvisor()` (shared with dashboard preview) |
| `PUT /api/auth/me/source-priority` | `sourcePriority()`, `analytics()` (cumulative metrics rerun) |
| `PUT /api/auth/me/coach-prefs` | `["coach", "prefs"]`, every conversation list query |

### iOS mirror

```swift
final class CacheInvalidator {
    private let store: NetworkCache
    func onMutation(_ kind: MutationKind) {
        switch kind {
        case .measurementChange:
            store.invalidate([.measurements, .analytics, .insightsRoot])
        case .moodEntryChange:
            store.invalidate([.moodEntries, .moodAnalytics, .analytics, .insightsRoot])
        case .medicationChange(let id):
            store.invalidate([
                .medications, .medicationDetail(id),
                .medicationIntakeSummary, .dashboardGlp1, .analytics
            ])
        // …
        }
    }
}
```

The web invalidation rule is "prefix match"; TanStack Query treats `["insights"]` as a prefix and invalidates every key starting with it (`["insights", "comprehensive"]`, `["insights", "blood-pressure-status", "en"]`, etc). iOS should expose the same semantics — typically by storing keys in a nested dictionary and walking subtrees.

---

## 5. Optimistic Updates

The Coach conversation list uses optimistic deletion to keep the rail responsive. Pattern:

```ts
// from src/components/insights/coach-panel/use-coach.ts:135-170 (Delete hook)
useMutation({
  mutationFn: async (id) => fetch(`/api/insights/chat/${id}`, { method: "DELETE" }),
  onMutate: async (id) => {
    await queryClient.cancelQueries({ queryKey: QUERY_KEYS.list() });
    const previous = queryClient.getQueryData<CoachConversationsPage>(QUERY_KEYS.list());
    if (previous) {
      queryClient.setQueryData(QUERY_KEYS.list(), {
        ...previous,
        conversations: previous.conversations.filter((c) => c.id !== id),
      });
    }
    return { previous };
  },
  onError: (_e, _id, ctx) => {
    if (ctx?.previous) queryClient.setQueryData(QUERY_KEYS.list(), ctx.previous);
  },
  onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEYS.list() }),
});
```

Three-phase contract: `onMutate` (paint optimistic), `onError` (roll back), `onSettled` (re-fetch ground truth).

iOS port — adopt the same three-phase model with `async let` cancellation tokens. The optimistic state lives in a `@Published` view-model property; on rollback, replace it with the captured snapshot.

The Coach drawer also surfaces an **optimistic user-message bubble** so the user sees their message instantly while the server is still streaming the assistant reply. See `CoachOptimisticUserMessage` at `src/components/insights/coach-panel/use-coach.ts:230-260`. iOS must replicate this — the SSE roundtrip latency on a cellular network makes the "where did my message go" feeling otherwise unavoidable.

---

## 6. The `useUser` / `useAuth` Pattern

```ts
// from src/hooks/use-auth.ts:1-44
export function useAuth() {
  const query = useQuery({
    queryKey: ["auth", "me"],
    queryFn: fetchMe,                  // returns AuthUser
    retry: false,                      // 401 → fail-fast → redirect to login
    staleTime: 5 * 60 * 1000,          // 5 min — re-fetches on focus past this
  });
  return {
    user: query.data ?? null,
    isLoading: query.isLoading,
    isAuthenticated: !!query.data,
    error: query.error,
    refetch: query.refetch,
  };
}
```

Important: `["auth", "me"]` is hand-keyed (not via `queryKeys.auth()`) for historical reasons. Both forms route to the same cache slot because the array shape is identical. **Do not "fix" this on the web side**; the test suite asserts the literal.

iOS counterpart:

```swift
@MainActor
final class AuthStore: ObservableObject {
    @Published private(set) var user: AuthUser?
    @Published private(set) var isLoading = true

    var isAuthenticated: Bool { user != nil }

    func refresh() async {
        do {
            self.user = try await api.fetch(.me, as: AuthUser.self)
        } catch APIError.unauthorized {
            self.user = nil
            await router.navigate(to: .login)
        } catch { /* keep last-known */ }
        self.isLoading = false
    }
}
```

The 401 → logout flow is built-in: any 401 from the iOS API client clears the auth store and routes to login.

---

## 7. The Shared `useInsightStatus` Hook (extracted-shared pattern)

Until v1.4.18 the six insights sub-pages each had a copy-pasted 13-line `useQuery` block. W18 extracted them into a single hook:

```ts
// from src/hooks/use-insight-status.ts:60-78
export function useInsightStatus(metric: InsightStatusMetric) {
  const { isAuthenticated } = useAuth();
  const { locale } = useTranslations();
  return useQuery({
    queryKey: QUERY_KEY_FACTORY[metric](locale),
    queryFn: async (): Promise<InsightStatusData> => {
      const res = await fetch(`/api/insights/${metric}-status?locale=${locale}`);
      if (!res.ok) throw new Error("Failed");
      const json = (await res.json()) as { data: InsightStatusData };
      return json.data;
    },
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });
}
```

Pattern matters more than the code: when ≥ 3 call sites copy-paste the same shape, extract. (See `18-pattern-cookbook.md` recipe "Extract a shared helper".) iOS adopts the same rule — when three view models hit the same endpoint with locale variance, the third one extracts a `loadInsightStatus(_ metric:)` helper.

---

## 8. Coach Streaming — SSE

The Coach is the only **streaming** surface in the app. Everything else is request/response.

### Wire format

`POST /api/insights/chat` returns `text/event-stream; charset=utf-8`. Frames:

```
data: {"type":"token","token":"Hello"}\n\n
data: {"type":"token","token":" world"}\n\n
data: {"type":"provenance","sources":[…]}\n\n
data: {"type":"done","messageId":"abc","conversationId":"xyz"}\n\n
```

Or on error:

```
data: {"type":"error","code":"AllProvidersFailed","message":"…"}\n\n
```

### Web parser

```ts
// from src/components/insights/coach-panel/use-coach.ts:170-205
export function parseSseChunk(buffer: string, chunk: string) {
  const combined = buffer + chunk;
  const events: CoachStreamEvent[] = [];
  let cursor = 0;
  while (cursor < combined.length) {
    const sep = combined.indexOf("\n\n", cursor);
    if (sep === -1) break;
    const frame = combined.slice(cursor, sep);
    cursor = sep + 2;
    const dataLine = frame.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    const payload = dataLine.slice("data:".length).trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as CoachStreamEvent;
      if (parsed && "type" in parsed) events.push(parsed);
    } catch { /* forward-compat: ignore unknown frames */ }
  }
  return { events, rest: combined.slice(cursor) };
}
```

Note the **forward-compat** comment — unknown event types must be silently dropped so server-side `type` additions (e.g. `tool_call` in v1.5) don't break older clients.

### iOS port

```swift
func streamCoachReply(
    body: CoachChatRequest,
    locale: String,
    onEvent: @escaping (CoachStreamEvent) -> Void
) async throws {
    var request = URLRequest(url: api.url(.coachChat))
    request.httpMethod = "POST"
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    request.httpBody = try JSONEncoder().encode(body)

    let (bytes, _) = try await session.bytes(for: request)
    var buffer = ""
    for try await line in bytes.lines {
        // accumulate, scan for `\n\n` separator, JSON-decode `data:` payload
        // (same algorithm as parseSseChunk above)
    }
}
```

Use `URLSession.bytes(for:)` (iOS 15+) — it gives an `AsyncSequence<UInt8>` that streams as bytes arrive. Wrap in a `TextDecoder` + the same frame-splitter as the web parser.

> STOP HERE if you try to make iOS poll for chunks. SSE on iOS is supported natively; do not introduce long-polling as a "simpler" alternative — the latency floor doubles and the user-facing typing animation breaks.

---

## 9. Stale-Time Policy

| Surface | `staleTime` | Why |
|---------|-------------|-----|
| `/api/auth/me` | 5 min | Profile rarely changes mid-session |
| `/api/analytics` | 0 | Always re-fetch on focus; dashboard is the user's truth |
| `/api/insights/*-status` | 60 s | Provider round-trips are expensive |
| `/api/insights/chat` (list) | 30 s | New conversations show up quickly |
| `/api/insights/chat/:id` | 60 s | Past messages don't change |
| `/api/medications` (list) | 0 | User edits should reflect immediately |

iOS: encode this in the `CacheKey.staleTime` per case, or as a constant policy map.

---

## 10. Self-Test

- [ ] Every iOS network call goes through a single `fetchEnvelope<T>` helper.
- [ ] Every cache key is a typed enum case, not a string.
- [ ] A mutation calls `cacheInvalidator.onMutation(.foo)` and never invalidates by hand.
- [ ] Optimistic mutations follow `onMutate → onError → onSettled` three-phase.
- [ ] The Coach drawer uses `URLSession.bytes` SSE, not polling.
- [ ] 401 responses route through one global handler that clears auth state.
- [ ] An unknown SSE `type` is silently dropped, not thrown.

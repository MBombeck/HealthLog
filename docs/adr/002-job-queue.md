# ADR-002: pg-boss for Job Queue over BullMQ

## Status

Accepted

## Context

We need a job queue for:

- Medication reminder checks (every 5-10 minutes)
- Withings fallback polling (every 30-60 minutes)
- Withings webhook-triggered sync jobs

Options: BullMQ (requires Redis) vs pg-boss (uses PostgreSQL).

## Decision

pg-boss — PostgreSQL-native job queue.

## Rationale

- No additional infrastructure (Redis) needed for M0-M4
- Simpler deployment (one fewer service in docker-compose)
- PostgreSQL already handles our sessions, auth challenges, and data
- pg-boss supports cron schedules, retries, backoff natively
- For our scale (single-user app), PostgreSQL-based queuing is more than sufficient
- Redis can be added later if needed for caching or higher throughput

## Trade-offs

- Lower throughput than BullMQ (not relevant at our scale)
- Job table lives in the same DB as application data (acceptable for single-user)

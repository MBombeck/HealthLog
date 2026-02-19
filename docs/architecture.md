# Architecture

## Overview

HealthLog is a Next.js 16 (App Router) health-tracking application with a PostgreSQL backend.
It tracks weight, blood pressure, pulse, and medication compliance via manual entry and Withings API integration.

## Tech Stack

| Layer         | Technology                                       |
| ------------- | ------------------------------------------------ |
| Framework     | Next.js 16 (App Router, RSC)                     |
| Language      | TypeScript (strict mode)                         |
| UI            | Tailwind CSS v4 + shadcn/ui + Radix UI           |
| Theme         | Dracula palette via CSS variables, next-themes   |
| Forms         | react-hook-form + zod                            |
| Data Fetching | TanStack Query                                   |
| Charts        | Recharts (smooth lines)                          |
| Database      | PostgreSQL 16 + Prisma ORM                       |
| Auth          | Passkeys (SimpleWebAuthn), optional password+2FA |
| Job Queue     | TBD: BullMQ+Redis or pg-boss (decided in M4)     |
| Deployment    | Docker + docker-compose, Coolify-ready           |

## Directory Structure

```
src/
├── app/                    # Next.js App Router pages & API routes
│   ├── api/                # API route handlers
│   │   ├── health/         # Healthcheck endpoint
│   │   ├── measurements/   # (M2) CRUD endpoints
│   │   ├── medications/    # (M4) CRUD + intake endpoints
│   │   ├── ingest/         # (M4) External medication ingest
│   │   ├── webhooks/       # (M5) Withings webhook
│   │   ├── auth/           # (M1) Auth endpoints
│   │   └── insights/       # (M6) OpenAI insights
│   ├── auth/               # Auth pages (login, register)
│   ├── measurements/       # Measurement CRUD UI
│   ├── medications/        # Medication UI
│   ├── charts/             # Chart views
│   ├── settings/           # User profile & settings
│   └── layout.tsx          # Root layout with providers
├── components/
│   ├── ui/                 # shadcn/ui primitives
│   ├── layout/             # Shell components (nav, topbar)
│   └── [feature]/          # Feature-specific components
├── lib/
│   ├── db.ts               # Prisma client singleton
│   ├── utils.ts            # cn() helper
│   ├── encryption.ts       # (M1) AES-256-GCM helpers
│   ├── auth/               # (M1) Auth utilities
│   └── analytics/          # (M3) Trend calculation
├── generated/prisma/       # Prisma generated client (gitignored)
└── hooks/                  # React hooks
prisma/
├── schema.prisma           # Database schema
└── migrations/             # Migration files
docs/
├── architecture.md         # This file
├── security.md             # Security design & OWASP mapping
├── assumptions.md          # Design assumptions
├── operations-coolify.md   # Deployment guide
├── api.md                  # API reference
└── adr/                    # Architecture Decision Records
```

## Key Patterns

### Server Components by Default

Pages and layouts are React Server Components. Client components are explicitly marked with `"use client"` and kept minimal (interactivity only).

### API Routes

All mutations go through Next.js API routes (`/app/api/`). Zod validates all inputs. Responses follow a consistent envelope: `{ data, error, meta }`.

### Database Access

Prisma client is a singleton (`src/lib/db.ts`). Never import Prisma in client components. All DB access happens server-side.

### Theme System

Dracula color palette is mapped to shadcn/ui CSS variables. The `dark` class (applied by next-themes) activates dark mode. Default theme is dark (Dracula).

### Encryption

Sensitive data (Withings tokens, OpenAI API keys, sensitive notes) is encrypted at the application level using AES-256-GCM before storage. The encryption key is derived from the `ENCRYPTION_KEY` env variable.

### Timezone

All user-facing times use `Europe/Berlin`. Database stores UTC. Conversion happens at the display layer.

#!/bin/sh
set -e

echo "HealthLog: Running database migrations..."
npx prisma migrate deploy 2>/dev/null || echo "HealthLog: Migration skipped (DB may not be ready or no pending migrations)"

echo "HealthLog: Starting application..."
exec "$@"

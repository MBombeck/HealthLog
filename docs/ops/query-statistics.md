# Query statistics (pg_stat_statements)

From v1.42 the bundled database loads the `pg_stat_statements` library, so the time spent in each query shape can be read from the database itself. Loading the library only collects statistics in shared memory; nothing is sent anywhere.

## Enable the view

The library is loaded through the `command:` of the `db` service in `docker-compose.yml`. The first `docker compose up` after updating restarts the database once. Then create the extension once:

```sh
docker compose exec db psql -U healthlog -d healthlog -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
```

## Read it

The slowest query shapes by total time:

```sh
docker compose exec db psql -U healthlog -d healthlog -c "SELECT calls, round(total_exec_time) AS total_ms, round(mean_exec_time, 1) AS mean_ms, left(query, 120) AS query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15;"
```

The statements are stored with their parameters replaced by placeholders, so values from your records do not appear in the view.

## Reset

```sh
docker compose exec db psql -U healthlog -d healthlog -c "SELECT pg_stat_statements_reset();"
```

If you run your own PostgreSQL instead of the bundled one, add `pg_stat_statements` to `shared_preload_libraries` in its configuration and restart it before creating the extension.

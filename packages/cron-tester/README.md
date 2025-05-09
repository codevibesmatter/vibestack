# Cron Tester

This package helps keep the Replication Durable Object active during local development by simulating Cloudflare's cron triggers.

## What it does

- Periodically sends HTTP requests to the `/cdn-cgi/handler/scheduled` endpoint
- Keeps the Replication DO from hibernating during development
- Maintains active polling in the Replication system

## How it works

When you run `pnpm dev` at the root of the monorepo, this package starts automatically along with the server and web applications. It waits 5 seconds for the server to start, then begins sending requests to the cron trigger endpoint every minute.

## Configuration

You can modify these settings in `src/index.js`:

- `POLL_INTERVAL_MS`: How frequently to trigger the cron (default: 60000ms / 1 minute)
- `INITIAL_DELAY_MS`: How long to wait before first trigger (default: 5000ms / 5 seconds)
- `SERVER_PORT`: Port where the server is running (default: 8787)

## Running manually

```bash
# From the package directory
pnpm dev

# From the monorepo root
pnpm --filter @repo/cron-tester dev
```

## Why is this needed?

Cloudflare Durable Objects naturally hibernate after a period of inactivity. In production, our cron trigger wakes up the DO every minute, but in development, Miniflare does not automatically trigger scheduled handlers.

This package simulates that behavior locally to ensure consistent behavior between development and production environments. 
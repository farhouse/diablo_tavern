# Guild Manager ARPG

Web-first ARPG tavern-management loop:

Meet two visitors → compare offers and needs → trade → commission a journey → claim the return → improve storage and appraisal.

## Stack

- Nuxt 4 full-stack
- TypeScript
- Pinia
- Nuxt UI + Tailwind-ready styling
- MongoDB
- JWT access token + simple refresh token

## Setup

### Docker Compose (dev)

```bash
docker compose up --build
```

Open `http://localhost:3000`.

This starts Nuxt in dev mode and MongoDB. Mongo data is stored in the `mongo_data` Docker volume.

Stop:
```bash
docker compose down
```

Reset Mongo data:
```bash
docker compose down -v
```

### Docker Compose (production beta)

```bash
INVITE_CODE=your-beta-code JWT_SECRET=change-this docker compose -f docker-compose.prod.yml up --build
```

Open `http://localhost:3000`.

This runs the production build. No file sync — rebuild to apply changes.

### Local

```bash
cp .env.example .env
pnpm install
pnpm dev
```

Default Mongo connection: `mongodb://127.0.0.1:27017`, database `diablo_management`.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MONGO_URI` | No | `mongodb://127.0.0.1:27017` | MongoDB connection string |
| `MONGO_DB_NAME` | No | `diablo_management` | Database name |
| `JWT_SECRET` | Yes | `dev-secret-change-me` | Secret for JWT tokens |
| `INVITE_CODE` | No | (none) | If set, registration requires this code |

## Scripts

```bash
pnpm dev         # Development server
pnpm build       # Production build
pnpm typecheck   # TypeScript check
pnpm test        # Unit tests
pnpm test:e2e:responsive # Self-contained responsive browser checks
```

`pnpm test:e2e:responsive` builds the current HEAD and starts its own production
preview on `127.0.0.1:3105`. Authentication and Tavern APIs use deterministic
fixtures, so MongoDB and demo credentials are not required. The runner refuses to
reuse an existing server and checks the Git SHA embedded in its compiled Nitro
bundle through `/api/build-info` before measuring the 2K, desktop, and mobile
layouts. Its Node launcher deliberately gives the preview a different runtime SHA
than the build, so that check fails if the endpoint ever stops reading the compiled
value. The launcher also forwards termination signals and cleans up its child
process tree on every exit path; Playwright grants that graceful shutdown a
bounded window before forcing termination.

This E2E launcher is POSIX-only because its cleanup contract depends on process
groups. On Windows, `pnpm test:e2e:responsive` fails before starting the build or
preview and reports the unsupported platform explicitly. Run it from Linux or
macOS (including a Linux CI runner) instead.

Install Chromium once with `pnpm exec playwright install chromium` when Playwright's
bundled browser is absent. To use a system Chromium build instead, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable path.

## Gameplay

1. **Login / Register** — create an account. If `INVITE_CODE` is set, you need it to register.
2. **Tavern** — compare two persisted visitors, their budgets, offers, interests, and commission odds.
3. **Trade** — buy one offer or sell one quoted stash item; useful equipment can improve a visitor's commission odds.
4. **Commission** — review region, duration, success chance, and all outcomes before sending the visitor.
5. **Return** — wait in real time, then claim a complete, partial, or failed result exactly once.
6. **Stash and Caravan** — identify stock, expand storage, or use emergency salvage for 25% of reference value.

## Features

- **Persistent visitor rounds** — refreshes preserve visitors, quotes, offers, and commissions
- **Server-authoritative trade** — persisted pricing and idempotent mutations prevent duplicate operations
- **Real-time commissions** — visitors return with complete, partial, or failed outcomes
- **Appraiser** — identify items for free over time (5min magic, 15min rare, 30min unique)
- **Visitor-centered progression** — storage and appraisal support the trade loop
- **Invite-code beta** — restrict registration to testers only
- **Item variety** — 20+ base items, 18 affixes, 5 unique items, and 4 visitor classes

## Backup

### MongoDB

```bash
docker exec -t diablo-managment-mongo-1 mongodump --db diablo_management --archive > backup-$(date +%Y%m%d).archive
```

Restore:
```bash
docker exec -i diablo-managment-mongo-1 mongorestore --archive < backup-20250101.archive
```

## Database wipe

There is no save-reset control in the player UI. To wipe all local data for every user:
```bash
docker compose down -v
```

## License

MIT

# Guild Manager ARPG

Web-first ARPG guild-management loop:

Hire hero → send expeditions → get loot/materials/gold → identify/sell/equip → upgrade caravan → unlock harder zones → prepare for Act boss.

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
```

## Gameplay

1. **Login / Register** — create an account. If `INVITE_CODE` is set, you need it to register.
2. **Tavern** — hire heroes. Roster capacity starts at 3; upgrade **Wagons** in Caravan for more.
3. **Caravan** — spend gold + materials to upgrade capacity for heroes, expeditions, stash, and services.
4. **Expeditions** — send heroes to explore. Events generate loot, gold, XP, and materials over time. **Recall** your party to bring rewards home.
5. **Stash** — identify items (pay gold or use the **Appraiser** for free over time), equip heroes, sell unwanted gear.
6. **Act Boss** — push depth to 100+ with a level 10+ hero to unlock the boss encounter.

## Features

- **Caravan progression** — 5 upgradeable services (Wagons, Scout Table, Stash Wagon, Infirmary, Appraiser)
- **Real-time expeditions** — heroes explore autonomously, events unfold every 5 seconds
- **Materials** — new resource earned from expeditions, used for caravan upgrades
- **Appraiser** — identify items for free over time (5min magic, 15min rare, 30min unique)
- **Infirmary** — reduces injury chance and death risk during expeditions
- **Multiple expeditions** — upgrade Scout Table to run 2–4 expeditions simultaneously
- **Invite-code beta** — restrict registration to testers only
- **Item variety** — 20+ base items, 18 affixes, 5 unique items, 4 hero classes

## Backup

### MongoDB

```bash
docker exec -t diablo-managment-mongo-1 mongodump --db diablo_management --archive > backup-$(date +%Y%m%d).archive
```

Restore:
```bash
docker exec -i diablo-managment-mongo-1 mongorestore --archive < backup-20250101.archive
```

## Reset / wipe

In the UI, use the **Reset save** button on the Stash page. This recreates a fresh save game for your user.

To wipe all data (all users):
```bash
docker compose down -v
```

## License

MIT

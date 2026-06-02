# Guild Manager ARPG

Web-first MVP for the ARPG guild-management loop:

Hire hero -> run quest -> get loot -> identify/sell/equip -> unlock harder quests.

## Stack

- Nuxt 4 full-stack
- TypeScript
- Pinia
- Nuxt UI + Tailwind-ready styling
- MongoDB
- JWT access token + simple refresh token

## Setup

### Docker Compose

```bash
docker compose up --build
```

Open `http://localhost:3000`.

This starts Nuxt and MongoDB. Mongo data is stored in the `mongo_data` Docker volume.

Stop the stack:

```bash
docker compose down
```

Reset Mongo data:

```bash
docker compose down -v
```

### Local

```bash
cp .env.example .env
pnpm install
pnpm dev
```

The default Mongo connection is `mongodb://127.0.0.1:27017`, database `diablo_management`.

## Scripts

```bash
pnpm dev
pnpm build
pnpm typecheck
pnpm test
```

## MVP Notes

- Stash is implemented as a limited item list for V1.
- Item `width`, `height`, and optional `position` are already in the model for a future grid inventory.
- Quest resolution is instant and server-authoritative.
- The Act I boss is the current end condition.

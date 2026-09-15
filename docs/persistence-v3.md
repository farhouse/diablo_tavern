## PersistedGameV3

V2 stores one Mongo document per `userId`. `itemsById` is the only actionable item registry; stash, visitor offers, commissions and service jobs contain item IDs only. `itemPlacements` records exactly one owner and custody for every item. Caravan capacity counts every caravan-owned item, including loans, service, settlement and recovery custody. Visitor-owned items and tombstones do not count.

`schemaVersion: 3` is an intentional reset. Reading any other version replaces it with a new V3 document by CAS and preserves only `userId`; no legacy economy or progression is migrated. A malformed document that already claims version 3 raises `PersistedGameCorruptError` and is never silently normalized.

Every mutation requires `expectedRevision`, `requestId`, a canonical command payload and a permanent business key. An exact replay returns the stored response before revision validation. Reusing the request ID with another command hash, using a stale revision, or reusing a business key fails without executing a rule. State, request record, business key and append-only ledger entry are replaced atomically under `{ userId, revision }`. A lost CAS result reloads the aggregate; it returns only if that exact request is now persisted.

The compatibility endpoint `/api/savegame` remains isolated for the current V1 UI. It is hydrated from V3 and strips `_id`, `userId`, request records, hashes, business keys, ledger, seeds and item bookkeeping. `/api/v2/game` returns the separate `GameView` projection and validates the real response with AJV 8.17.1, draft 2020-12, `strict: true`, followed by semantic ownership/capacity checks.

Mongo's single-document replacement is the transaction boundary, so a replica-set transaction is unnecessary. The unique `userId` index prevents duplicate aggregates; permanent business keys inside that aggregate prevent duplicate effects after request-record expiry.

## Equipment V2 Loot And Services

Equipment V2 server-only facts live in `itemV2ById`. Generated loot uses `server/domain/loot-v2.ts` and config version `loot-v2.2026-09-15`; the client never sends table IDs, weights, rolls, sealed affixes, provenance, materials or boss imprint data. The current zone tables map quest `lootTableId` values to weighted base/rarity entries:

- `act1-low`: early normal/magic drops, including imperfect starter pieces.
- `act1-mid`: magic/rare drops, including `wanderer-set` combinations and imperfect pieces.
- `act1-high`: higher rare/unique drops from tower/catacomb zones.
- `act1-boss`: rare/unique boss drops and a pending `boss-act-boss` imprint.

Commission settlement rewards are converted at the `PersistedGameV3` boundary. `buildPersistedFromPublic` ignores the legacy placeholder reward item identity and calls the versioned loot generator with injected `random`, `uuid` and `now` dependencies. Provenance stores `zoneId`, `lootTableId`, `configVersion`, permanent `businessKey`, optional `combinationId`/`imperfectPieceId`, and `droppedAt`. If a previous item already has the same loot business key, that exact item/state is reused so retries, reloads and later claim mutations do not create a second reward.

V2 equipment endpoints are handled by `POST /api/v2/actions/:action` with closed payloads:

- `{ requestId, expectedRevision, itemId, optionId }` for `identify_item`, `queue_blacksmith_job`, and `queue_enchanter_job`.
- `{ requestId, expectedRevision, itemId, optionId, acknowledgementId }` for `dismantle_item` and `replace_boss_imprint`.

Action options and acknowledgements are HMAC-sealed by the server against the effective runtime JWT secret, revision, item, action, semantic option and expiration. Artisan jobs debit cost when queued, persist their result before the response, complete through reconciliation, and keep terminal history. Dismantle moves the item to tombstone custody and credits configured scrap only; `goldDelta` remains zero.

## Verification

Run the normal checks:

```bash
pnpm exec nuxi prepare
pnpm vitest run tests/savegame-atomic.test.ts tests/persisted-game-v3.test.ts
pnpm contract:validate
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Run real-Mongo integration against an isolated database:

```bash
MONGO_TEST_URI=mongodb://127.0.0.1:27017 pnpm exec vitest run tests/savegame-mongo.integration.test.ts
```

The suite always uses database `diablo_tavern_alta43_integration`, prefixes test user IDs with `alta43-<pid>`, and deletes only the exact IDs created by that process. It never uses or clears `diablo_management`.

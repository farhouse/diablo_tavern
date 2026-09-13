## PersistedGameV3

V2 stores one Mongo document per `userId`. `itemsById` is the only actionable item registry; stash, visitor offers, commissions and service jobs contain item IDs only. `itemPlacements` records exactly one owner and custody for every item. Caravan capacity counts every caravan-owned item, including loans, service, settlement and recovery custody. Visitor-owned items and tombstones do not count.

`schemaVersion: 3` is an intentional reset. Reading any other version replaces it with a new V3 document by CAS and preserves only `userId`; no legacy economy or progression is migrated. A malformed document that already claims version 3 raises `PersistedGameCorruptError` and is never silently normalized.

Every mutation requires `expectedRevision`, `requestId`, a canonical command payload and a permanent business key. An exact replay returns the stored response before revision validation. Reusing the request ID with another command hash, using a stale revision, or reusing a business key fails without executing a rule. State, request record, business key and append-only ledger entry are replaced atomically under `{ userId, revision }`. A lost CAS result reloads the aggregate; it returns only if that exact request is now persisted.

The compatibility endpoint `/api/savegame` remains isolated for the current V1 UI. It is hydrated from V3 and strips `_id`, `userId`, request records, hashes, business keys, ledger, seeds and item bookkeeping. `/api/v2/game` returns the separate `GameView` projection and validates the real response with AJV 8.17.1, draft 2020-12, `strict: true`, followed by semantic ownership/capacity checks.

Mongo's single-document replacement is the transaction boundary, so a replica-set transaction is unnecessary. The unique `userId` index prevents duplicate aggregates; permanent business keys inside that aggregate prevent duplicate effects after request-record expiry.

## Verification

Run the normal checks:

```bash
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

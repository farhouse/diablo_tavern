## V2 visitor cycle API

The visitor lifecycle is projected by `GET /api/v2/game`. Reads are effect-free: elapsed expeditions, settlement defaults, recovery results and expirations advance only through `POST /api/v2/reconcile`.

All commands require authentication and the exact envelope below. Unknown top-level or payload fields are rejected. Clients select only IDs exposed by the current `GameView`; prices, rewards, percentages, expiry timestamps and outcomes are server-owned.

```json
{
  "requestId": "client-generated-id",
  "expectedRevision": 12,
  "payload": {}
}
```

Successful commands return `{ "requestId", "revision", "game" }`. Replaying the same request and payload returns that exact stored success. A reused request ID with different content, a stale revision, or a reused permanent business key returns the V2 error envelope without applying effects.

| Command | Payload |
| --- | --- |
| `POST /api/v2/contracts/accept` | `{ visitorId, optionId, loanItemIds }` |
| `POST /api/v2/expeditions/start` | `{ contractId }` |
| `POST /api/v2/reconcile` | `{}` |
| `POST /api/v2/settlements/confirm` | `{ settlementId, previewVersion, selectedOptionIds }` |
| `POST /api/v2/recoveries/assign` | `{ recoveryId, visitorId, optionId, loanItemIds }` |
| `POST /api/v2/recoveries/abandon` | `{ recoveryId, acknowledgementId }` |

Accepting a contract atomically seals the selected contract terms and any caravan-owned stash loans. Starting the expedition persists its complete event schedule. Reconciliation applies due events in timestamp order, applies damage before evaluating death, and evaluates the inclusive retreat threshold only for a surviving visitor. Every outcome first creates an effect-free settlement preview. Confirmation or expiry-default settlement applies gold and loan disposition exactly once. Death settlement opens recovery for exactly the expedition's loaned items; recovery resolution never captures visitor-owned items.

The old commission and claim routes are tombstones and return `TERMINAL_ENTITY`. Legacy save reads no longer advance legacy commissions, and trade or dismissal cannot mutate a visitor while its V2 lifecycle is busy.

## Persistence and rollout

`visitorCycle` is an additive field on `PersistedGameV3`. Existing valid V3 documents are backfilled through revision-guarded replacement; no game reset or destructive migration is required. The existing Mongo configuration is unchanged.

## Verification

```bash
MONGO_TEST_URI=mongodb://127.0.0.1:27017 pnpm test
pnpm contract:validate
pnpm check:v2-types
pnpm typecheck
pnpm build
```

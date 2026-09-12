# Visitor, trade, and commission server contract

## Save schema

`SaveGame` is the MongoDB aggregate and currently uses `schemaVersion: 2`. Version 2 is intentionally incompatible with the previous hired-hero game: loading a missing or different schema version recreates the aggregate with the same `userId`, 450 gold, two identified common items, two visitor posts, and revision-protected visitor state. Legacy gold, items, heroes, equipment, quests, expeditions, materials, and rewards are discarded.

The persisted aggregate contains only commerce state: gold, stash, the Stash Wagon and Appraiser, unlocked commission region IDs, the current visitor round, bounded visit history, idempotency records, revision, and timestamps. A reload returns the persisted visitor identities, offers, quotes, commission previews, schedule, sealed result, and transaction history unchanged except for due time transitions committed under CAS.

## HTTP contract

Every POST requires a caller-generated `requestId` (maximum 128 characters). Retrying the same operation and payload returns current persisted state without applying it twice. Reusing a `requestId` for another operation or payload returns `409`. Writes compare the aggregate revision and retry from the newly persisted document after a CAS loss.

| Method and path | Additional body | Effect |
|---|---|---|
| `POST /api/visitors/:visitorId/buy` | `offerId` | Buy one persisted visitor offer. |
| `POST /api/visitors/:visitorId/sell` | `itemId` | Sell one quoted item to that visitor. |
| `POST /api/visitors/:visitorId/commission` | `optionId`: `safe` or `risky` | Assign a persisted commission preview after trading. |
| `POST /api/visitors/:visitorId/claim` | none | Apply a ready commission reward once and free the post. |
| `POST /api/visitors/:visitorId/dismiss` | none | Archive and release a visitor without an active commission. |
| `POST /api/items/:itemId/identify` | none | Pay to identify one stash item. |
| `POST /api/items/:itemId/salvage` | none | Destroy one item for 25% of reference value. |
| `POST /api/caravan/upgrade` | `upgradeId`: `stashWagon` or `appraiser` | Buy a supported caravan upgrade. |
| `POST /api/appraiser/start` | `itemId` | Queue an unidentified item. |
| `POST /api/appraiser/complete` | none | Complete every due appraisal. |
| `POST /api/savegame/reset` | none | Create a fresh version-2 aggregate. |

There are no hire, hero equipment/control, legacy quest/expedition, or global-sale endpoints. `optionId` is mandatory; the old commission `regionId` request shape is rejected.

## Economy and lifecycle

- Visitor offer prices are persisted at 90–125% of item value.
- Desired-type quotes are persisted at 80–110%; other accepted types use 40–60%.
- A visitor may buy once and sell once, in either order. Arrival-time quotes prevent same-visit buy/resell arbitrage.
- Each new arrival has at least one viable commercial sequence. Recovery stock is added only to break a no-cash/no-identified-item soft lock.
- A commissioned visitor occupies its post through `active → ready`; claiming applies the sealed reward once, archives the visit, and schedules the next arrival check.
- Generic liquidation is explicitly `salvage`, pays 25%, and cannot be confused with visitor trade.

## Reproducible verification

`tests/visitor-logic.test.ts` runs 1,000 turnovers with seed `20260910`: zero soft locks, -450 net gold (-0.45 per turnover), and 0 final gold from a 450 start. The player still has a quoted stash asset, so the zero-gold endpoint is not a soft lock. `tests/savegame-atomic.test.ts` covers concurrent CAS writers, lost-response retries, duplicate claims, persisted time transitions, and incompatible-save recreation. `tests/savegame-mongo.integration.test.ts` repeats CAS, idempotent retry, exact reload, and old-schema replacement against real MongoDB when `MONGO_TEST_URI` is provided. `tests/visitor-flow.integration.test.ts` covers arrival → bilateral trade → commission → return → claim → empty posts through handlers, store, and rendered Tavern.

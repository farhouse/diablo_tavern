# Visitor, trade, and commission server contract

The current save document remains the aggregate boundary. Existing `heroes`, expeditions, materials, and caravan data are preserved; legacy saves are normalized by adding `revision`, `processedRequestIds`, fingerprinted `processedRequests`, `visitHistory`, and one persisted two-visitor `visitRound`.

Each `Visitor` persists an `origin` string and an `equipmentSummary` array. Summary entries expose `name`, `type`, and their `powerBonus` (plus `itemId` when the item came from a player trade), so clients can render identity and gear without reconstructing domain state. Selling useful equipment appends its summary entry in the same atomic mutation that updates `power` and commission probabilities. Legacy visitors receive a deterministic origin and starting-equipment summary; any power above the original level baseline is retained as a migrated tavern-equipment bonus.

New saves start with 450 gold and two identified normal items. A legacy save with neither a sellable item nor enough gold for a correctly priced offer receives one normal recovery item when a round is generated. This is the only anti-soft-lock subsidy.

## State and pricing

- Visitor states: `open → traded → commissioned → returned → departed`, or `open|traded → departed` through dismissal.
- Each visitor may complete one bilateral trade. Sold player items never enter that visitor's offers, and quotes cover only items present when the round was created, preventing same-round buy/resell arbitrage.
- Offer prices are persisted at 90–125% of `Item.value`.
- Desired-type quotes are persisted at 80–110%; accepted non-desired types use 40–60%. Non-accepted types are rejected.
- Generic `/api/items/:itemId/sell` is retained only as emergency salvage and pays 25%.

## HTTP mutations

All endpoints require authentication and a caller-generated `requestId` in the JSON body, unique within the save's rolling 100-mutation retry window. A repeated ID for the same operation returns the already-current save without applying the operation twice; reuse for a different operation or payload returns `409`. Both the keys and their operation fingerprints are persisted. Writes use an atomic revision compare-and-swap on the single MongoDB save document. Time-based commission transitions observed during reads are also persisted with the same revision guard.

| Method and path | Additional body | Effect |
|---|---|---|
| `POST /api/visitors/:visitorId/buy` | `offerId` | Buy a persisted visitor offer. |
| `POST /api/visitors/:visitorId/sell` | `itemId` | Accept a persisted visitor quote. |
| `POST /api/visitors/:visitorId/commission` | `regionId` | Assign one persisted commission option after trade. |
| `POST /api/visitors/:visitorId/claim` | none | Reveal/apply a completed commission exactly once. |
| `POST /api/visitors/:visitorId/dismiss` | none | Resolve a visitor with no pending commission. |

`SaveGame.visitRound.visitors[].commissionOptions` is the preview contract: region, duration, success probability, and full/partial gold rewards are available before confirmation. Assignment persists the completion timestamp and outcome roll. Selling identified, level-appropriate equipment useful to the visitor's class increases visitor power and recalculates the displayed probabilities. At most two unclaimed commissions exist in the current round.

## Deterministic economy check

`tests/visitor-logic.test.ts` runs 1,000 rounds with seed `20260910` and a simple sell-when-possible / buy-when-needed strategy. Result: 0 soft-locks, -437 net gold, -0.437 gold/round, and 13 final gold from a 450 start. The test asserts zero unavailable rounds, average net gold below 5 per round, and final gold below 10× starting gold. The price spread plus round-snapshot quotes removes guaranteed direct arbitrage or explosive growth; the recovery item only activates from a no-action state.

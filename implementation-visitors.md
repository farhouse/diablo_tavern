# Visitor, trade, and commission server contract

The current save document remains the aggregate boundary. Existing `heroes`, expeditions, materials, and caravan data are preserved; legacy saves are normalized by adding `revision`, `processedRequestIds`, fingerprinted `processedRequests`, `visitHistory`, and one persisted two-slot `visitRound`.

`visitRound.slots` always has two stable slots. An occupied slot has `visitor`; an empty slot has `nextArrivalCheckAt`. Dismissal and claim first archive a bounded one-visitor snapshot in `visitHistory`, then remove the visitor immediately and schedule the first persisted arrival check. A commissioned or returned visitor remains in its slot. When an empty slot is due, the server rolls once under CAS: success installs a new persisted visitor, while failure advances the persisted clock to the next check. Legacy `visitRound.visitors` arrays (including departed visitors) migrate to this slot representation without touching historical heroes, visitor history, or economic state.

Each `Visitor` persists an `origin` string and an `equipmentSummary` array. Summary entries expose `name`, `type`, and their `powerBonus` (plus `itemId` when the item came from a player trade), so clients can render identity and gear without reconstructing domain state. Selling useful equipment appends its summary entry in the same atomic mutation that updates `power` and commission probabilities. Legacy visitors receive a deterministic origin and starting-equipment summary; any power above the original level baseline is retained as a migrated tavern-equipment bonus.

New saves start with 450 gold and two identified normal items. Visitor generation guarantees a persisted quote for at least one stash item and a correctly priced offer affordable with current gold or the guaranteed sale proceeds. Therefore the player gets one real sale and one real purchase opportunity whenever stash capacity permits the corresponding action. A legacy save with neither a sellable item nor enough purchasing power receives one normal recovery item when visitors are generated. This is the only anti-soft-lock subsidy.

## State and pricing

- Visitor states while occupying a slot: `open → traded → commissioned → returned`; dismissal or claim removes the visitor from the slot after recording `departedAt` on the in-memory mutation.
- Each visitor may buy one quoted player item and sell one persisted offer, in either order. A second trade of the same kind is rejected. Sold player items never enter that visitor's offers, and quotes cover only items present when the visitor arrived, preventing same-visit buy/resell arbitrage.
- Offer prices are persisted at 90–125% of `Item.value`.
- Desired-type quotes are persisted at 80–110%; accepted non-desired types use 40–60%. Non-accepted types are rejected.
- Generic `/api/items/:itemId/sell` is retained only as emergency salvage and pays 25%.

## HTTP mutations

All endpoints require authentication and a caller-generated `requestId` in the JSON body, unique within the save's rolling 100-mutation retry window. A repeated ID for the same operation returns the already-current save without applying the operation twice; reuse for a different operation or payload returns `409`. Both the keys and their operation fingerprints are persisted. Writes use an atomic revision compare-and-swap on the single MongoDB save document. Time-based commission transitions observed during reads are also persisted with the same revision guard.

| Method and path | Additional body | Effect |
|---|---|---|
| `POST /api/visitors/:visitorId/buy` | `offerId` | Buy a persisted visitor offer. |
| `POST /api/visitors/:visitorId/sell` | `itemId` | Accept a persisted visitor quote. |
| `POST /api/visitors/:visitorId/commission` | `optionId` (`safe` or `risky`); legacy `regionId` accepted temporarily | Assign one of the two persisted commission options after trade. A legacy region selects `safe` and retains the old operation fingerprint for retry compatibility. |
| `POST /api/visitors/:visitorId/claim` | none | Reveal/apply a completed commission exactly once. |
| `POST /api/visitors/:visitorId/dismiss` | none | Resolve a visitor with no pending commission. |

`SaveGame.visitRound.slots[].visitor.commissionOptions` always contains exactly two previews for the hardest unlocked region. `safe` is shorter and more likely, with lower rewards and low risk; `risky` is longer and less likely, with higher rewards and high risk. Both expose `title`, region, duration, success probability, full/partial gold rewards, `riskLevel`, and `failureConsequence` before confirmation. Assignment persists the selected option, completion timestamp, and outcome roll. Selling identified, level-appropriate equipment useful to the visitor's class increases visitor power and recalculates both displayed probabilities. At most two unclaimed commissions exist because commissioned visitors continue occupying the two slots.

## Initial tuning

All initial tuning lives in the exported `VISITOR_CONFIG` object in `utils/visitor-logic.ts`:

- 2 visitor slots.
- Arrival check every 30 seconds; 40% arrival chance per due check.
- `safe`: 0.75× base duration, +15 percentage points over base success, 0.60× full and 0.20× partial region gold.
- `risky`: 1.75× base duration, -15 percentage points from base success, 1.35× full and 0.35× partial region gold.
- Success is clamped to 5–95%. Failure yields no reward; the explicitly displayed risk is the occupied slot and elapsed duration.

Changing these values does not change the persisted shape. Existing visitors retain their concrete schedules, prices, and sealed results. Legacy previews are normalized to the hardest region currently unlocked by that save; active legacy commissions keep their concrete duration, chance, rewards, timestamps, and sealed roll while receiving the missing display metadata.

## Persistence, CAS, and retries

Arrival checks, commission returns, dismissal schedules, and all trade/commission/claim mutations are persisted with the save revision compare-and-swap. A CAS loser reloads before rolling or mutating again. An idempotent replay consults the persisted operation fingerprint first and then uses the normal read path, so a due clock transition is persisted rather than returned as an uncommitted in-memory change. Reusing a request ID for a different operation or payload remains `409`.

## Deterministic economy check

`tests/visitor-logic.test.ts` runs 1,000 visitor turnovers with seed `20260910` and a simple sell-when-possible / buy-when-needed strategy. The test asserts zero unavailable states, average net gold below 5 per turnover, and final gold below 10× starting gold. The price spread plus arrival-snapshot quotes removes guaranteed direct arbitrage or explosive growth; the recovery item only activates from a no-action state.

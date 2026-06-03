# Implementation Plan: Portal Return and Timed Recall

## Summary

Add a new expedition event where the party finds a temporary portal back to camp. While the portal is active, the player can return instantly. If the player recalls without a portal, the expedition enters a safe returning state and completes after half of the expedition's elapsed time.

This is intended to make recall a more meaningful decision without making the MVP harder to test.

## Gameplay Rules

- Expeditions can generate a new event type: `portal`.
- A portal stays usable for 30 seconds from the event timestamp.
- Only exploring expeditions can find a portal.
- An expedition cannot generate a second portal while one is currently active.
- Using an active portal immediately completes the expedition and transfers carried rewards.
- Normal recall no longer completes immediately.
- Normal recall changes the expedition to `returning`.
- Return duration is half of the expedition elapsed time at the moment recall is requested.
- Returning expeditions do not generate new events, damage, loot, gold, XP, or materials.
- When `returnsAt` is reached, the expedition completes with the same reward and injury/death resolution used by current recall.

## Data Model Changes

Update `ExpeditionEvent.type` to include:

```ts
| 'portal'
```

Update `ActiveExpedition` with optional fields:

```ts
portalAvailableUntil?: string
portalEventId?: string
returnStartedAt?: string
returnsAt?: string
```

Normalization requirements:

- Existing saves must continue to load with these fields missing.
- If an expedition has `status === 'returning'` but no `returnsAt`, normalize it back to `exploring` to avoid a stuck state.
- If `portalAvailableUntil` is in the past, it can be cleared during `advanceExpedition`.

## Logic Changes

### Event generation

- Add `portal` to `pickExpeditionEventType`.
- Suggested initial weight: `4`.
- Portal weight should be `0` when:
  - expedition is not `exploring`
  - `portalAvailableUntil` exists and is still in the future
  - expedition is already `returning`

### Event application

When a `portal` event is applied:

- Set `expedition.portalAvailableUntil = event.createdAt + 30 seconds`.
- Set `expedition.portalEventId = event.id`.
- Do not add rewards or damage for the portal event.

### Advance

`advanceExpedition` should:

- Normalize save.
- For each expedition:
  - Clear expired portal fields.
  - If `status === 'returning'` and `returnsAt <= now`, complete the expedition.
  - If `status === 'returning'` and not due yet, do not generate events.
  - Otherwise generate events as today.

### Recall

Change `recallExpedition` to accept an options object:

```ts
recallExpedition(save, expeditionId, now, { usePortal?: boolean })
```

Behavior:

- `usePortal: true`
  - Requires `portalAvailableUntil >= now`.
  - Completes the expedition immediately.
  - Clears portal fields as part of removing the active expedition.
  - Throws `Portal is no longer available` if expired or missing.
- `usePortal: false`
  - If already returning, return the save unchanged except for `touchSave`.
  - Advance the expedition up to `now` before starting return.
  - Set `status = 'returning'`.
  - Set `returnStartedAt = now`.
  - Set `returnsAt = now + ((now - startedAt) / 2)`.
  - Clear any active portal fields.
  - Do not transfer rewards until `returnsAt`.

Extract the current final recall resolution into an internal helper, for example:

```ts
completeExpeditionReturn(save, expedition, now)
```

This helper should preserve current behavior for:

- reward transfer
- stash overflow handling
- XP distribution
- injury/death status
- expedition history summary
- active expedition removal

## API and Store Changes

Update `POST /api/expeditions/recall` body:

```ts
{
  expeditionId: string
  usePortal?: boolean
}
```

Update store action:

```ts
recallExpedition(expeditionId: string, usePortal = false)
```

No new endpoint is required.

## UI Changes

In each expedition `UCard`:

- If a portal is active:
  - Show a visible portal badge.
  - Show remaining portal time.
  - Primary button becomes `Use Portal`.
  - Clicking it calls `recallExpedition(expedition.id, true)`.
- If no portal is active and expedition is exploring/boss-ready:
  - Show `Recall Party`.
  - Clicking it starts timed return.
- If expedition is returning:
  - Show `Returning` badge.
  - Show ETA / remaining return time.
  - Disable the recall button.
  - Keep showing party health and carried rewards.

Timer display can reuse the existing 3-second polling loop. No per-second countdown is required for the first implementation, but the timestamp should be shown clearly enough for testing.

## Tests

Add or update game logic tests for:

- Portal event sets `portalAvailableUntil` and `portalEventId`.
- Portal expires after 30 seconds during `advanceExpedition`.
- Using an active portal completes immediately and transfers rewards.
- Using a missing or expired portal throws `Portal is no longer available`.
- Normal recall sets `status: 'returning'`, `returnStartedAt`, and `returnsAt`.
- Normal recall does not transfer rewards immediately.
- `advanceExpedition` completes a returning expedition after `returnsAt`.
- Returning expeditions do not generate new events.
- Existing recall tests are updated to either use portal or advance to `returnsAt`.

## Acceptance Criteria

- The player can see when a portal is available in the expedition card.
- The player can use the portal to return instantly.
- If the player ignores the portal, it expires after 30 seconds.
- Recall without portal starts a timed return instead of completing immediately.
- Returning expeditions complete automatically through the existing advance loop.
- Existing saves continue loading.
- `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.


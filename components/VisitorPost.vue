<template>
  <article class="visitor-post" :class="`visitor-post--${visitor.state}`" :aria-labelledby="`visitor-${visitor.id}`">
    <header class="visitor-header">
      <div class="visitor-identity">
        <HeroSprite
          data-testid="visitor-sprite"
          :hero-class="visitor.class"
          :alt="`${visitor.name}, ${classLabel} visitor`"
        />
        <div>
          <div class="visitor-title-row">
            <h2 :id="`visitor-${visitor.id}`">{{ visitor.name }}</h2>
            <span class="state-chip">{{ stateLabel }}</span>
          </div>
          <p>{{ classLabel }} · level {{ visitor.level }}</p>
          <p class="muted">From {{ visitor.origin }}</p>
        </div>
      </div>
      <div class="visitor-ledger" aria-label="Visitor resources">
        <strong>{{ visitor.budget }}g</strong>
        <span>budget</span>
        <strong>{{ visitor.power }}</strong>
        <span>gear power</span>
      </div>
    </header>

    <section class="visitor-equipment" :aria-labelledby="`equipment-${visitor.id}`">
      <div>
        <h3 :id="`equipment-${visitor.id}`">Travel gear</h3>
        <p class="muted">Persisted equipment · routes: {{ routeLabel }}</p>
      </div>
      <ul>
        <li v-for="item in visitor.equipmentSummary" :key="item.itemId ?? `${item.type}-${item.name}`">
          <ItemSprite :item-type="item.type" :alt="`${item.name}, ${item.type}`" />
          <span class="equipment-copy">
            <strong>{{ item.name }}</strong>
            <span>{{ capitalize(item.type) }} · {{ item.powerBonus > 0 ? `+${item.powerBonus} power` : 'starting gear' }}</span>
          </span>
        </li>
      </ul>
    </section>

    <template v-if="visitor.state === 'open' || visitor.state === 'traded'">
      <section class="visitor-section" :aria-labelledby="`interests-${visitor.id}`">
        <h3 :id="`interests-${visitor.id}`">Looking for {{ interestLabel }}</h3>
        <p class="muted">Also accepts {{ acceptedLabel }} when a quote is shown.</p>
      </section>

      <div class="trade-columns">
        <section class="visitor-section" :aria-labelledby="`offers-${visitor.id}`">
          <h3 :id="`offers-${visitor.id}`">On their blanket</h3>
          <div class="item-list">
            <article v-for="offer in purchasableOffers" :key="offer.id" class="trade-item">
              <ItemSprite
                :data-testid="`offer-sprite-${offer.id}`"
                :item-type="offer.item.type"
                :alt="itemImageAlt(offer.item)"
              />
              <div>
                <strong>{{ itemName(offer.item) }}</strong>
                <p>{{ itemMeta(offer.item) }}</p>
              </div>
              <button
                :data-testid="`buy-${offer.id}`"
                class="btn primary"
                type="button"
                :disabled="Boolean(buyDisabledReason(offer))"
                :aria-describedby="buyDisabledReason(offer) ? `buy-reason-${offer.id}` : undefined"
                @click="$emit('buy', visitor.id, offer.id)"
              >
                Buy for {{ offer.price }}g
              </button>
              <p v-if="buyDisabledReason(offer)" :id="`buy-reason-${offer.id}`" class="action-reason">{{ buyDisabledReason(offer) }}</p>
            </article>
            <p v-if="hasBought" class="empty-copy trade-complete">Purchase used for this visit.</p>
            <p v-else-if="!purchasableOffers.length" class="empty-copy">Nothing else is for sale.</p>
          </div>
        </section>

        <section class="visitor-section" :aria-labelledby="`quotes-${visitor.id}`">
          <h3 :id="`quotes-${visitor.id}`">Your quoted goods</h3>
          <div class="item-list">
            <article v-for="entry in sellableQuotes" :key="entry.item.id" class="trade-item">
              <ItemSprite
                :data-testid="`quote-sprite-${entry.item.id}`"
                :item-type="entry.item.type"
                :alt="itemImageAlt(entry.item)"
              />
              <div>
                <strong>{{ itemName(entry.item) }}</strong>
                <p>{{ visitor.interestedItemTypes.includes(entry.item.type) ? 'Wanted item' : 'Accepted item' }} · {{ itemMeta(entry.item) }}</p>
              </div>
              <button
                :data-testid="`sell-${entry.item.id}`"
                class="btn"
                type="button"
                :disabled="Boolean(sellDisabledReason(entry.quote))"
                :aria-describedby="sellDisabledReason(entry.quote) ? `sell-reason-${entry.item.id}` : undefined"
                @click="$emit('sell', visitor.id, entry.item.id)"
              >
                Sell for {{ entry.quote }}g
              </button>
              <p v-if="sellDisabledReason(entry.quote)" :id="`sell-reason-${entry.item.id}`" class="action-reason">{{ sellDisabledReason(entry.quote) }}</p>
            </article>
            <p v-if="hasSold" class="empty-copy trade-complete">Sale used for this visit.</p>
            <p v-else-if="!sellableQuotes.length" class="empty-copy">This visitor has no quote for your current stash.</p>
          </div>
        </section>
      </div>
      <div v-if="tradeImpact" class="impact-note" role="status">
        <strong>Equipment changed the odds.</strong>
        Power {{ tradeImpact.powerBefore }} → {{ tradeImpact.powerAfter }}.
        <span v-for="change in tradeImpact.chances" :key="change.optionId">
          {{ titleCase(change.optionId) }} {{ percent(change.before) }} → {{ percent(change.after) }}.
        </span>
      </div>

      <section v-if="visitor.state === 'traded'" :id="`commissions-${visitor.id}`" class="visitor-section mission-board" :aria-labelledby="`missions-${visitor.id}`">
        <div>
          <h3 :id="`missions-${visitor.id}`">Choose a commission</h3>
          <p class="muted">The server has fixed the duration, odds and rewards shown here.</p>
        </div>
        <article v-for="option in visitor.commissionOptions" :key="option.optionId" :data-testid="`mission-${option.optionId}`" class="mission-option">
          <div class="mission-heading">
            <div>
              <strong>{{ option.title }}</strong>
              <p>{{ questName(option.regionId) }}</p>
            </div>
            <span class="risk-chip" :class="`risk-chip--${option.riskLevel}`">{{ capitalize(option.riskLevel) }} risk</span>
          </div>
          <dl class="mission-facts">
            <div><dt>Success</dt><dd>{{ percent(option.successChance) }}</dd></div>
            <div><dt>Duration</dt><dd>{{ duration(option.durationMs) }}</dd></div>
            <div><dt>Full reward</dt><dd>{{ option.fullRewardGold }}g + item</dd></div>
          </dl>
          <ul class="mission-consequences">
            <li>Complete: {{ option.fullRewardGold }}g and one item if stash has room.</li>
            <li>Partial: {{ option.partialRewardGold }}g.</li>
            <li>Failure: {{ option.failureConsequence }}</li>
          </ul>
          <button :data-testid="`review-${option.optionId}`" class="btn" type="button" :aria-expanded="reviewingOptionId === option.optionId" :aria-controls="reviewingOptionId === option.optionId ? `review-${visitor.id}-${option.optionId}` : undefined" @click="toggleReview(option.optionId)">
            {{ reviewingOptionId === option.optionId ? 'Cancel selection' : `Select ${option.optionId}` }}
          </button>
          <div v-if="reviewingOptionId === option.optionId" :id="`review-${visitor.id}-${option.optionId}`" class="mission-review">
            <p>Confirm this persisted option. The visitor will occupy this post until the return is claimed.</p>
            <button
              :data-testid="`confirm-${option.optionId}`"
              class="btn primary"
              type="button"
              :disabled="pending"
              :aria-describedby="pending ? `commission-reason-${visitor.id}` : undefined"
              @click="$emit('commission', visitor.id, option.optionId)"
            >
              {{ pending ? 'Sending…' : `Send ${visitor.name}` }}
            </button>
            <p v-if="pending" :id="`commission-reason-${visitor.id}`" class="action-reason">Another action is being processed.</p>
          </div>
        </article>
      </section>
    </template>

    <section v-else-if="visitor.state === 'commissioned' && visitor.commission" class="away-state">
      <div class="away-summary">
        <span class="state-icon" aria-hidden="true">⌛</span>
        <div>
          <h3>Away on commission</h3>
          <p>{{ questName(visitor.commission.regionId) }} · {{ remainingLabel }} remaining</p>
          <p class="muted">Return time: {{ returnTime(visitor.commission.finishesAt) }}. Refresh is safe; the server keeps this state.</p>
        </div>
      </div>
      <div class="journey-progress" aria-hidden="true">
        <span :style="{ width: `${journeyProgress}%` }" />
      </div>
      <section class="journey-log" :aria-labelledby="`journey-${visitor.id}`" data-testid="journey-log">
        <div class="journey-heading">
          <h4 :id="`journey-${visitor.id}`">Journey log</h4>
          <span>{{ journeyMilestones.length }} of 4 reports</span>
        </div>
        <ol aria-label="Reports received from the road">
          <li v-for="milestone in journeyMilestones" :key="milestone.id">
            <time :datetime="milestone.reachedAt">{{ milestoneTime(milestone.reachedAt) }}</time>
            <div>
              <strong>{{ milestone.title }}</strong>
              <p>{{ milestone.description }}</p>
            </div>
          </li>
        </ol>
        <p class="journey-note">Road reports describe the route only. The sealed commission result remains unknown until return.</p>
      </section>
    </section>

    <section v-else-if="visitor.state === 'returned' && visitor.commission" class="return-state" aria-live="polite">
      <div>
        <h3>Returned: {{ outcomeLabel }} result</h3>
        <p>{{ resultDescription }}</p>
      </div>
      <button
        :data-testid="`claim-${visitor.id}`"
        class="btn primary"
        type="button"
        :disabled="pending"
        @click="$emit('claim', visitor.id)"
      >
        {{ pending ? 'Claiming…' : claimLabel }}
      </button>
    </section>

    <section v-else class="departed-state">
      <h3>The post is empty</h3>
      <p class="muted">This post checks independently for a new visitor after its next arrival check.</p>
    </section>

    <footer v-if="visitor.state === 'open' || visitor.state === 'traded'" class="visitor-footer">
      <p class="muted">{{ visitor.state === 'open' ? 'No deal is required.' : 'At least one trade is complete. Use the remaining direction, send a commission or finish the visit.' }}</p>
      <button :data-testid="`dismiss-${visitor.id}`" class="btn ghost" type="button" :disabled="pending" :aria-describedby="pending ? `dismiss-reason-${visitor.id}` : undefined" @click="$emit('dismiss', visitor.id)">
        {{ pending ? 'Processing…' : visitor.state === 'open' ? 'Let depart' : 'Finish visit' }}
      </button>
      <p v-if="pending" :id="`dismiss-reason-${visitor.id}`" class="action-reason">Another action is being processed.</p>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import HeroSprite from '~/components/HeroSprite.vue'
import ItemSprite from '~/components/ItemSprite.vue'
import type { Item, Quest, Visitor, VisitorOffer } from '~/types/game'
import { getVisitorJourneyMilestones, getVisitorJourneyProgress } from '~/utils/visitor-journey'

interface TradeImpact {
  powerBefore: number
  powerAfter: number
  chances: Array<{ optionId: 'safe' | 'risky'; before: number; after: number }>
}

const props = withDefaults(defineProps<{
  visitor: Visitor
  stash: Item[]
  gold: number
  stashLimit: number
  quests: Quest[]
  now: number
  pending?: boolean
  tradeImpact?: TradeImpact
}>(), { pending: false, tradeImpact: undefined })

defineEmits<{
  buy: [visitorId: string, offerId: string]
  sell: [visitorId: string, itemId: string]
  commission: [visitorId: string, optionId: 'safe' | 'risky']
  claim: [visitorId: string]
  dismiss: [visitorId: string]
}>()

const reviewingOptionId = ref('')
const availableOffers = computed(() => props.visitor.offers.filter((offer) => !offer.purchasedAt))
const quotedItems = computed(() => props.stash.flatMap((item) => {
  const quote = props.visitor.buyQuotes[item.id]
  return item.identified && typeof quote === 'number' && props.visitor.acceptedItemTypes.includes(item.type) ? [{ item, quote }] : []
}))
const hasBought = computed(() => props.visitor.trades.some((trade) => trade.kind === 'player_bought'))
const hasSold = computed(() => props.visitor.trades.some((trade) => trade.kind === 'player_sold'))
const purchasableOffers = computed(() => hasBought.value ? [] : availableOffers.value)
const sellableQuotes = computed(() => hasSold.value ? [] : quotedItems.value)
const classLabel = computed(() => capitalize(props.visitor.class))
const routeLabel = computed(() => [...new Set(props.visitor.commissionOptions.map((option) => questName(option.regionId)))].join(', ') || 'no unlocked routes')
const interestLabel = computed(() => naturalList(props.visitor.interestedItemTypes))
const acceptedLabel = computed(() => naturalList(props.visitor.acceptedItemTypes))
const stateLabel = computed(() => ({
  open: 'Ready to trade', traded: 'Deal made', commissioned: 'Away', returned: 'Returned', departed: 'Departed'
}[props.visitor.state]))
const remainingLabel = computed(() => {
  if (!props.visitor.commission) return '0s'
  return duration(Math.max(0, new Date(props.visitor.commission.finishesAt).getTime() - props.now))
})
const journeyMilestones = computed(() => props.visitor.commission
  ? getVisitorJourneyMilestones(props.visitor.commission, props.now)
  : [])
const journeyProgress = computed(() => props.visitor.commission
  ? Math.round(getVisitorJourneyProgress(props.visitor.commission, props.now) * 100)
  : 0)
const outcomeLabel = computed(() => props.visitor.commission?.outcome || 'unknown')
const resultDescription = computed(() => {
  const commission = props.visitor.commission
  if (!commission) return ''
  if (commission.outcome === 'complete') return `Full reward: ${commission.rewardGold ?? commission.fullRewardGold}g${props.stash.length < props.stashLimit ? ' and one item' : '; reward item cannot fit in the full stash'}.`
  if (commission.outcome === 'partial') return `Partial reward: ${commission.rewardGold ?? commission.partialRewardGold}g.`
  return 'The expedition failed. There is no reward to collect.'
})
const claimLabel = computed(() => {
  const reward = props.visitor.commission?.rewardGold ?? 0
  return reward ? `Claim ${reward}g` : 'Acknowledge return'
})

function toggleReview(optionId: string) {
  reviewingOptionId.value = reviewingOptionId.value === optionId ? '' : optionId
}

function buyDisabledReason(offer: VisitorOffer): string {
  if (props.pending) return 'Another action is being processed.'
  if (props.stash.length >= props.stashLimit) return 'Stash is full.'
  if (props.gold < offer.price) return `Need ${offer.price - props.gold}g more.`
  return ''
}

function sellDisabledReason(quote: number): string {
  if (props.pending) return 'Another action is being processed.'
  if (props.visitor.budget < quote) return 'Visitor cannot afford this quote.'
  return ''
}

function questName(regionId: string): string {
  return props.quests.find((quest) => quest.id === regionId)?.name || titleCase(regionId)
}

function itemName(item: Item): string {
  return item.identified ? item.displayName : `Unidentified ${capitalize(item.rarity)} ${item.baseName}`
}

function itemMeta(item: Item): string {
  return `${capitalize(item.type)} · level ${item.requiredLevel} · ${capitalize(item.rarity)}`
}

function itemImageAlt(item: Item): string {
  return `${itemName(item)}, ${item.rarity} ${item.type}`
}

function duration(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1000)
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes ? `${minutes}m${remainder ? ` ${remainder}s` : ''}` : `${remainder}s`
}

function percent(chance: number): string {
  return `${Math.round(chance * 100)}%`
}

function returnTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function milestoneTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function naturalList(values: string[]): string {
  return values.map(capitalize).join(', ').replace(/, ([^,]*)$/, ' and $1').toLowerCase()
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function titleCase(value: string): string {
  return value.split('-').map(capitalize).join(' ')
}
</script>

<style scoped>
.visitor-post {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  container-type: inline-size;
  display: grid;
  gap: 1rem;
  min-width: 0;
  padding: 1.1rem;
}

.visitor-post--returned { border-color: var(--ok); }
.visitor-post--departed { opacity: 0.72; }
.visitor-header, .visitor-title-row, .visitor-footer, .return-state, .visitor-identity {
  align-items: center;
  display: flex;
  gap: 0.75rem;
}
.visitor-header, .visitor-footer, .return-state { justify-content: space-between; }
.visitor-title-row { flex-wrap: wrap; }
.visitor-header h2, .visitor-header p, .visitor-section h3, .visitor-section p, .away-state h3, .away-state p,
.return-state h3, .return-state p, .departed-state h3, .departed-state p, .trade-item p { margin: 0; }
.visitor-ledger {
  display: grid;
  flex: 0 0 auto;
  gap: 0.1rem 0.45rem;
  grid-template-columns: auto auto;
  text-align: right;
}
.visitor-ledger span { color: var(--muted); font-size: 0.78rem; }
.visitor-equipment { align-items: start; border-block: 1px solid var(--line); display: grid; gap: 0.75rem; grid-template-columns: minmax(8rem, 0.4fr) 1fr; padding-block: 0.8rem; }
.visitor-equipment h3, .visitor-equipment p { margin: 0; }
.visitor-equipment ul { display: flex; flex-wrap: wrap; gap: 0.5rem; list-style: none; margin: 0; padding: 0; }
.visitor-equipment li { align-items: center; background: #14120f; border-radius: 6px; display: flex; gap: 0.55rem; min-width: min(100%, 12rem); padding: 0.35rem 0.55rem; }
.visitor-equipment li :deep(.item-sprite) { height: 44px; width: 44px; }
.equipment-copy { display: grid; gap: 0.1rem; }
.equipment-copy > span { color: var(--muted); font-size: 0.78rem; }
.state-chip {
  background: #14120f;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--accent-2);
  font-size: 0.78rem;
  padding: 0.2rem 0.5rem;
}
.visitor-section { display: grid; gap: 0.65rem; }
.trade-columns { display: grid; gap: 1rem; grid-template-columns: 1fr 1fr; }
.item-list { display: grid; gap: 0.55rem; }
.trade-item, .mission-option {
  align-items: center;
  background: #14120f;
  border: 1px solid var(--line);
  border-radius: 8px;
  display: grid;
  gap: 0.65rem;
  padding: 0.75rem;
}
.trade-item { grid-template-columns: auto minmax(0, 1fr) auto; }
.mission-option { grid-template-columns: minmax(0, 1fr) auto; }
.trade-item :deep(.item-sprite) { height: 54px; width: 54px; }
.trade-item p, .mission-option p { color: var(--muted); font-size: 0.85rem; }
.action-reason { color: var(--bad) !important; grid-column: 1 / -1; }
.empty-copy { color: var(--muted); padding: 0.65rem 0; }
.mission-board { border-top: 1px solid var(--line); padding-top: 1rem; }
.mission-heading { align-items: start; display: flex; gap: 0.75rem; justify-content: space-between; }
.mission-facts { display: grid; gap: 0.45rem; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; }
.mission-facts div { display: grid; gap: 0.1rem; }
.mission-facts dt { color: var(--muted); font-size: 0.76rem; }
.mission-facts dd { font-weight: 750; margin: 0; }
.risk-chip { border: 1px solid var(--line); border-radius: 999px; flex: 0 0 auto; font-size: 0.75rem; padding: 0.2rem 0.5rem; }
.risk-chip--low { color: var(--ok); }
.risk-chip--high { color: var(--bad); }
.trade-complete { color: var(--ok); }
.mission-review { border-top: 1px solid var(--line); display: grid; gap: 0.65rem; grid-column: 1 / -1; padding-top: 0.75rem; }
.mission-consequences { color: var(--muted); display: grid; gap: 0.25rem; grid-column: 1 / -1; margin: 0; padding-left: 1.2rem; }
.impact-note { background: #17231a; border: 1px solid #315b3b; border-radius: 8px; display: grid; gap: 0.25rem; padding: 0.8rem; }
.away-state, .return-state, .departed-state { background: #14120f; border-radius: 8px; padding: 1rem; }
.away-state { display: grid; gap: 0.9rem; }
.away-summary { align-items: center; display: flex; gap: 0.8rem; }
.state-icon { font-size: 1.5rem; }
.journey-progress { background: var(--panel-2); border-radius: 999px; height: 0.3rem; overflow: hidden; }
.journey-progress span { background: var(--accent-2); display: block; height: 100%; transition: width 200ms ease-out; }
.journey-log { border-top: 1px solid var(--line); display: grid; gap: 0.7rem; padding-top: 0.85rem; }
.journey-heading { align-items: baseline; display: flex; gap: 0.75rem; justify-content: space-between; }
.journey-heading h4 { font-size: 0.95rem; margin: 0; }
.journey-heading span, .journey-log time { color: var(--muted); font-size: 0.76rem; }
.journey-log ol { display: grid; gap: 0.65rem; list-style: none; margin: 0; padding: 0; }
.journey-log li { align-items: start; display: grid; gap: 0.65rem; grid-template-columns: 4.6rem minmax(0, 1fr); }
.journey-log li > div { display: grid; gap: 0.12rem; }
.journey-log li p, .journey-note { color: var(--muted); font-size: 0.82rem; margin: 0; text-wrap: pretty; }
.journey-note { border-top: 1px solid var(--line); padding-top: 0.7rem; }
.visitor-footer { border-top: 1px solid var(--line); padding-top: 0.85rem; }

@container (max-width: 680px) {
  .trade-columns { grid-template-columns: 1fr; }
  .trade-item { grid-template-columns: auto minmax(0, 1fr); }
  .trade-item .btn { grid-column: 1 / -1; }
  .mission-option { grid-template-columns: 1fr; }
  .trade-item .btn, .mission-option .btn { justify-content: center; width: 100%; }
}

@media (max-width: 720px) {
  .visitor-header, .visitor-footer, .return-state { align-items: stretch; flex-direction: column; }
  .visitor-ledger { align-self: start; text-align: left; }
  .visitor-equipment { grid-template-columns: 1fr; }
  .trade-columns { grid-template-columns: 1fr; }
  .trade-item { grid-template-columns: auto minmax(0, 1fr); }
  .mission-option { grid-template-columns: 1fr; }
  .mission-facts { grid-template-columns: 1fr 1fr; }
  .journey-heading { align-items: start; flex-direction: column; gap: 0.2rem; }
  .journey-log li { grid-template-columns: 4rem minmax(0, 1fr); }
  .trade-item .btn, .mission-option .btn, .return-state .btn, .visitor-footer .btn { justify-content: center; width: 100%; }
}

@media (prefers-reduced-motion: reduce) { .journey-progress span { transition: none; } }
</style>

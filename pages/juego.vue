<template>
  <main class="page game-home">
    <section v-if="game.errorMessage && !game.game" class="page-alert page-alert--error" role="alert">
      <span>{{ game.errorMessage }}</span>
      <button class="btn" type="button" @click="game.load">Reintentar</button>
    </section>

    <section v-if="game.loadState === 'loading' && !game.game" class="camp-loading" aria-busy="true">
      Encendiendo las luces del campamento…
    </section>

    <section v-else-if="game.game" class="camp" aria-labelledby="camp-title">
      <header class="camp-hud">
        <div class="camp-title-block">
          <h1 id="camp-title">Diablo Tavern</h1>
          <p>{{ nextStep.title }}</p>
        </div>
        <div class="camp-resources" aria-label="Recursos de la partida">
          <span><strong>{{ game.game.resources.gold }}</strong> oro</span>
          <span><strong>{{ game.game.caravan.visitorCapacity.used }}/{{ game.game.caravan.visitorCapacity.limit }}</strong> visitantes</span>
          <span><strong>{{ game.game.capacity.used }}/{{ game.game.capacity.limit }}</strong> objetos</span>
          <button class="camp-refresh" type="button" :disabled="game.loadState === 'loading'" @click="game.load">
            {{ game.loadState === 'loading' ? 'Actualizando…' : 'Actualizar' }}
          </button>
        </div>
      </header>

      <div class="camp-stage">
        <img class="camp-background pixel-sprite" src="/images/game/camp-modular/camp-base.png" alt="" width="1672" height="941">
        <img class="camp-expansion camp-expansion--wagon pixel-sprite" src="/images/game/camp-modular/expansion-stash-wagon.png" alt="" width="360" height="272">
        <img class="camp-expansion camp-expansion--appraiser pixel-sprite" src="/images/game/camp-modular/expansion-appraiser.png" alt="" width="447" height="321">

        <button class="camp-place camp-place--wagon" type="button" @click="openLocation('caravan', $event)"><span>Caravana</span><small>Mejoras y manutención</small></button>
        <button class="camp-place camp-place--tavern" type="button" @click="openLocation('tavern', $event)"><span>Taberna</span><small>Visitantes y expediciones</small></button>
        <button class="camp-place camp-place--blacksmith" type="button" @click="openService('blacksmith', $event)"><span>Herrería</span><small>Mejorar y desmantelar</small></button>
        <button class="camp-place camp-place--appraiser" type="button" @click="openService('appraiser', $event)"><span>Tasador</span><small>Identificar objetos</small></button>
        <button class="camp-place camp-place--chronicle" type="button" @click="openLocation('chronicle', $event)"><span>Mesa de campaña</span><small>Crónica del viaje</small></button>

      </div>

      <aside class="next-order" aria-label="Próxima acción recomendada">
        <div><strong>{{ nextStep.title }}</strong><span>{{ nextStep.description }}</span></div>
        <button type="button" @click="openNextStep($event)">{{ nextStep.button }}</button>
      </aside>

      <section class="hero-dock" aria-label="Héroes en el campamento">
        <p v-if="!activeVisitors.length" class="hero-empty">Las fogatas esperan a los próximos viajeros.</p>
        <button v-for="visitor in activeVisitors" :key="visitor.visitorId" class="hero-portrait" type="button" @click="openVisitor(visitor.visitorId, $event)">
          <HeroSprite :hero-class="heroClassForVisitor(visitor.visitorId)" alt="" />
          <span><strong>{{ visitor.name.fallback }}</strong><small>{{ visitorState(visitor.state) }}</small></span>
        </button>
      </section>
    </section>

    <dialog ref="campDialog" class="camp-dialog" :class="{ 'camp-dialog--trade': selectedVisitor && !selectedVisitorRecovering && ['available', 'negotiating'].includes(selectedVisitor.state), 'camp-dialog--appraiser': service === 'appraiser', 'camp-dialog--blacksmith': service === 'blacksmith', 'camp-dialog--equipment': service === 'all', 'camp-dialog--caravan': location === 'caravan', 'camp-dialog--tavern': location === 'tavern', 'camp-dialog--chronicle': location === 'chronicle' }" aria-labelledby="camp-dialog-title" @close="onDialogClosed" @click="closeOnBackdrop">
      <header class="camp-dialog__header">
        <div class="camp-dialog__identity">
          <HeroSprite v-if="selectedVisitor" :hero-class="heroClassForVisitor(selectedVisitor.visitorId)" alt="" />
          <div>
            <h2 id="camp-dialog-title">{{ dialogTitle }}</h2>
            <p>{{ dialogDescription }}</p>
          </div>
        </div>
        <button ref="closeButton" class="camp-dialog__close" type="button" autofocus aria-label="Cerrar" @click="closeDialog">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <EquipmentV2
        v-if="service"
        :service="service"
        modal
        :game="game.game"
        :load-state="game.loadState"
        :operation-state="game.operationState"
        :error-message="game.errorMessage"
        :unavailable-reason="game.unavailableReason"
        :snapshot-stale="game.snapshotStale"
        @reload="reload"
        @retry="game.retryEquipmentUncertain"
        @action="game.runEquipmentAction"
      />
      <VisitorCycleV2
        v-else-if="selectedVisitor || location === 'tavern'"
        :visitor-id="selectedVisitor?.visitorId"
        :game="game.game"
        :load-state="game.loadState"
        :operation-state="game.operationState"
        :error-message="game.errorMessage"
        :unavailable-reason="game.unavailableReason"
        :snapshot-stale="game.snapshotStale"
        @accept-contract="game.acceptContract"
        @start-expedition="game.startExpedition"
        @reconcile-game="game.reconcileGame"
        @reconcile-due-transition="game.reconcileDueTransition"
        @confirm-settlement="game.confirmSettlement"
        @assign-recovery="game.assignRecovery"
        @abandon-recovery="game.abandonRecovery"
        @retry="game.retryUncertain"
        @reload="game.retryConflictReload"
        @close="closeDialog"
      />
      <CaravanV2
        v-else-if="location === 'caravan'"
        :game="game.game"
        :load-state="game.loadState"
        :operation-state="game.operationState"
        :error-message="game.errorMessage"
        :unavailable-reason="game.unavailableReason"
        :snapshot-stale="game.snapshotStale"
        @reload="reload"
        @retry="game.retryUncertain"
        @upgrade="game.upgradeCaravan"
      />
      <ChronicleV2
        v-else-if="location === 'chronicle'"
        :entries="chronicle.entries"
        :load-state="chronicle.loadState"
        :error-message="chronicle.errorMessage"
        :load-more-state="chronicle.loadMoreState"
        :load-more-error="chronicle.loadMoreError"
        :has-more="chronicle.hasMore"
        @reload="chronicle.load"
        @load-more="chronicle.loadMore"
      />
    </dialog>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import CaravanV2 from '~/components/CaravanV2.vue'
import ChronicleV2 from '~/components/ChronicleV2.vue'
import EquipmentV2 from '~/components/EquipmentV2.vue'
import HeroSprite from '~/components/HeroSprite.vue'
import VisitorCycleV2 from '~/components/VisitorCycleV2.vue'
import type { ActionAvailability } from '~/shared/types/v2-game-view'
import { heroClassForVisitor } from '~/utils/game-assets'
import { useGameV2Store } from '~/stores/game-v2'
import { useChronicleV2Store } from '~/stores/chronicle-v2'

type CampService = 'appraiser' | 'blacksmith' | 'all'
type CampLocation = 'caravan' | 'tavern' | 'chronicle'

const game = useGameV2Store()
const chronicle = useChronicleV2Store()
const service = ref<CampService | null>(null)
const location = ref<CampLocation | null>(null)
const selectedVisitorId = ref<string | null>(null)
const campDialog = ref<HTMLDialogElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const dialogTrigger = ref<HTMLElement | null>(null)
const activeVisitors = computed(() => game.game?.visitors.filter((visitor) => !['departed', 'dead'].includes(visitor.state)).slice(0, 4) ?? [])
const selectedVisitor = computed(() => game.game?.visitors.find((visitor) => visitor.visitorId === selectedVisitorId.value) ?? null)
const selectedVisitorRecovering = computed(() => game.game?.recoveries.some((recovery) => recovery.state === 'assigned' && recovery.assignedVisitorId === selectedVisitorId.value) ?? false)
const dialogTitle = computed(() => selectedVisitor.value?.name.fallback ?? ({ blacksmith: 'Herrería', appraiser: 'Tasador', all: 'Equipo', caravan: 'Caravana', tavern: 'Taberna', chronicle: 'Crónica' } as Record<string, string>)[service.value ?? location.value ?? ''] ?? '')
const dialogDescription = computed(() => selectedVisitor.value ? (selectedVisitorRecovering.value ? 'En recuperación' : visitorState(selectedVisitor.value.state)) : ({ blacksmith: 'Mejorá o desmantelá objetos sin abandonar el campamento.', appraiser: 'Revelá las propiedades de los objetos sin abandonar el campamento.', all: 'Inventario y trabajos de la caravana.', caravan: 'Capacidad, manutención y mejoras.', tavern: 'Visitantes, expediciones y resultados.', chronicle: 'Los sucesos de tu caravana.' } as Record<string, string>)[service.value ?? location.value ?? ''] ?? '')

function enabled(actions: readonly ActionAvailability[], action: ActionAvailability['action']) {
  return actions.some((candidate) => candidate.action === action && candidate.enabled)
}

const nextStep = computed(() => {
  const view = game.game
  if (!view) return { title: 'Cargá tu partida', description: 'Necesitamos el estado actual para recomendarte el próximo paso.', button: 'Actualizar', target: 'refresh' as const }
  if (view.settlements.some((entry) => entry.state === 'preview_ready' && enabled(entry.actions, 'confirm_settlement'))) return { title: 'Confirmá el resultado de una expedición', description: 'La recompensa está lista para resolver.', button: 'Ver resultado', target: 'tavern' as const }
  if (view.recoveries.some((entry) => entry.state === 'open')) return { title: 'Resolvé una recuperación pendiente', description: 'Todavía podés recuperar objetos prestados.', button: 'Ver recuperación', target: 'tavern' as const }
  if (view.visitors.some((entry) => entry.state === 'contracted' && enabled(entry.actions, 'start_expedition'))) return { title: 'Iniciá la expedición contratada', description: 'El visitante está preparado para salir.', button: 'Iniciar', target: 'tavern' as const }
  if (view.visitors.some((entry) => (entry.state === 'available' || entry.state === 'negotiating') && enabled(entry.actions, 'accept_contract'))) return { title: 'Elegí un contrato', description: 'Hay visitantes esperando en la taberna.', button: 'Ver visitantes', target: 'tavern' as const }
  if (view.expeditions.some((entry) => entry.state === 'active')) return { title: 'Hay una expedición en marcha', description: 'Actualizá sus sucesos cuando esté lista.', button: 'Ver expedición', target: 'tavern' as const }
  if (view.items.some((item) => item.actions.some((action) => action.enabled))) return { title: 'Prepará tu equipo', description: 'Hay servicios disponibles en el campamento.', button: 'Ver equipo', target: 'equipment' as const }
  return { title: 'El campamento está en calma', description: 'Podés preparar mejoras o consultar la crónica.', button: 'Ver caravana', target: 'caravan' as const }
})

onMounted(() => { if (!game.game) void game.load() })

async function reload() {
  if (game.snapshotStale) await game.retryConflictReload()
  else await game.load()
}

async function openService(nextService: CampService, event: Event) {
  selectedVisitorId.value = null
  location.value = null
  service.value = nextService
  await openDialog(event)
}

async function openLocation(nextLocation: CampLocation, event: Event) {
  selectedVisitorId.value = null
  service.value = null
  location.value = nextLocation
  if (nextLocation === 'chronicle') void chronicle.load()
  await openDialog(event)
}

async function openVisitor(visitorId: string, event: Event) {
  service.value = null
  location.value = null
  selectedVisitorId.value = visitorId
  await openDialog(event)
}

function openNextStep(event: Event) {
  const target = nextStep.value.target
  if (target === 'refresh') return reload()
  if (target === 'equipment') return openService('all', event)
  return openLocation(target, event)
}

async function openDialog(event: Event) {
  dialogTrigger.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  await nextTick()
  campDialog.value?.showModal()
  closeButton.value?.focus()
}

function closeDialog() { campDialog.value?.close() }
function closeOnBackdrop(event: MouseEvent) { if (event.target === campDialog.value) closeDialog() }
function onDialogClosed() {
  service.value = null
  location.value = null
  selectedVisitorId.value = null
  nextTick(() => dialogTrigger.value?.focus())
}
function visitorState(state: string) {
  return ({ available: 'Disponible', negotiating: 'Negociando', contracted: 'Contratado', away: 'En expedición', awaiting_settlement: 'De regreso' } as Record<string, string>)[state] ?? state
}
</script>

<style scoped>
.game-home { max-width: 1720px; padding-top: 1rem; }
.camp { border: 1px solid #5c4730; box-shadow: 0 1rem 3rem rgba(0, 0, 0, .45); overflow: hidden; position: relative; }
.camp-stage { aspect-ratio: 1672 / 941; background: #0b0d14; min-height: 38rem; overflow: hidden; position: relative; }
.camp-background { height: 100%; inset: 0; object-fit: cover; position: absolute; width: 100%; }
.camp-expansion { height: auto; pointer-events: none; position: absolute; }
.camp-expansion--wagon { left: 4.19%; top: 9.67%; width: 21.53%; }
.camp-expansion--appraiser { left: 73.27%; top: 22.85%; width: 26.73%; }
.camp-hud { align-items: start; display: flex; gap: 1rem; justify-content: space-between; left: 0; padding: 1rem; position: absolute; right: 0; top: 0; z-index: 30; }
.camp-title-block { background: linear-gradient(90deg, rgba(8, 8, 10, .9), rgba(8, 8, 10, .58)); padding: .8rem 1.1rem; text-shadow: 0 2px 4px #000; }
.camp-title-block h1 { color: #f0c26a; font-family: Georgia, 'Times New Roman', serif; font-size: clamp(1.4rem, 2.6vw, 2.6rem); letter-spacing: -.02em; margin: 0; }
.camp-title-block p { color: #f6ead5; margin: .2rem 0 0; }
.camp-resources { align-items: stretch; display: flex; flex-wrap: wrap; gap: .35rem; justify-content: end; }
.camp-resources span, .camp-refresh { background: rgba(8, 8, 10, .88); border: 1px solid #6c5438; color: #e8dccb; min-height: 2.75rem; padding: .55rem .75rem; }
.camp-resources strong { color: #f0c26a; }
.camp-refresh { cursor: pointer; }
.camp-refresh:hover, .camp-refresh:focus-visible { border-color: #f0c26a; }
.camp-place { appearance: none; background: transparent; border: 1px solid transparent; color: #fff3d4; cursor: pointer; display: flex; flex-direction: column; justify-content: end; padding: .6rem; position: absolute; text-align: left; text-shadow: 0 2px 4px #000; z-index: 20; }
.camp-place::after { background: rgba(8, 8, 10, .86); border: 1px solid #80613d; bottom: .35rem; content: ''; inset-inline: .35rem; position: absolute; top: auto; height: 3.4rem; z-index: -1; }
.camp-place span { font-family: Georgia, 'Times New Roman', serif; font-size: clamp(.9rem, 1.25vw, 1.25rem); font-weight: 700; }
.camp-place small { color: #d2c3ac; font-size: clamp(.62rem, .75vw, .78rem); }
.camp-place:hover, .camp-place:focus-visible { border-color: #f0c26a; box-shadow: inset 0 0 2.5rem rgba(239, 157, 54, .18); }
.camp-place--wagon { height: 31%; left: 3%; top: 8%; width: 24%; }
.camp-place--tavern { height: 42%; left: 29%; top: 16%; width: 42%; }
.camp-place--blacksmith { height: 34%; left: 2%; top: 38%; width: 28%; }
.camp-place--appraiser { height: 35%; left: 72%; top: 22%; width: 27%; }
.camp-place--chronicle { height: 30%; left: 58%; top: 50%; width: 32%; }
.next-order { align-items: center; background: linear-gradient(90deg, rgba(10, 9, 10, .94), rgba(29, 19, 13, .9)); border: 1px solid #725536; bottom: 18%; display: flex; gap: 1rem; justify-content: space-between; left: 1rem; max-width: min(34rem, calc(100% - 2rem)); padding: .65rem .8rem; position: absolute; z-index: 31; }
.next-order div { display: grid; gap: .15rem; }
.next-order strong { color: #f0c26a; }
.next-order span { color: #d2c3ac; font-size: .82rem; }
.next-order button { background: #a94327; border: 1px solid #bf6144; color: #fff3d4; cursor: pointer; flex: 0 0 auto; font: inherit; min-height: 2.75rem; padding: .65rem .8rem; }
.next-order button:hover, .next-order button:focus-visible { background: #bd4c2e; border-color: #f0c26a; }
.hero-dock { align-items: stretch; background: linear-gradient(180deg, rgba(4, 5, 8, .92), #08090d); border-top: 2px solid #6c5438; bottom: 0; display: flex; gap: .45rem; height: 17%; left: 0; padding: .5rem max(.75rem, 20%); position: absolute; right: 0; z-index: 30; }
.hero-portrait { align-items: end; appearance: none; background: transparent; border: 1px solid #554a3a; color: inherit; cursor: pointer; display: flex; flex: 1 1 0; gap: .5rem; justify-content: center; min-width: 0; padding: .25rem .45rem; text-align: left; }
.hero-portrait:hover, .hero-portrait:focus-visible { background: #1c1711; border-color: #f0c26a; }
.hero-portrait :deep(.hero-sprite) { height: min(8vw, 6rem); width: min(5.3vw, 4rem); }
.hero-portrait span { display: grid; min-width: 0; padding-bottom: .25rem; }
.hero-portrait strong { color: #f0c26a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hero-portrait small { color: #bdb1a0; }
.hero-empty { align-self: center; color: #bdb1a0; margin: auto; }
.camp-loading { align-items: center; background: url('/images/game/camp-modular/camp-base.png') center / cover; border: 1px solid #5c4730; display: flex; justify-content: center; min-height: 38rem; text-shadow: 0 2px 4px #000; }
.camp-dialog { animation: dialog-enter 180ms cubic-bezier(.16, 1, .3, 1); background: #1b1712; border: 1px solid #9d7444; box-shadow: 0 1.5rem 5rem rgba(0, 0, 0, .65); color: var(--text); margin: auto; max-height: 90dvh; max-width: 64rem; overflow: hidden; padding: 0; scrollbar-color: #80613d #100d0a; width: calc(100% - 2rem); }
.camp-dialog[open] { display: flex; flex-direction: column; }
.camp-dialog--trade { height: min(48rem, 90dvh); }
.camp-dialog::backdrop { background: rgba(3, 4, 7, .62); backdrop-filter: blur(1px); }
.camp-dialog__header { align-items: center; background: linear-gradient(90deg, rgba(15, 12, 9, .94), rgba(22, 16, 10, .42)), url('/images/game/camp-modular/camp-base.png') center 42% / cover; border-bottom: 1px solid #725536; display: flex; flex: 0 0 auto; gap: 1rem; justify-content: space-between; min-height: 8rem; padding: .75rem 1.5rem; z-index: 5; }
.camp-dialog--blacksmith .camp-dialog__header { background-position: center, left 58%; background-size: cover, 140%; }
.camp-dialog--appraiser .camp-dialog__header { background-image: linear-gradient(90deg, #100e14 30%, rgba(20, 14, 28, .35)), url('/images/game/camp-modular/expansion-appraiser.png'); background-position: center, right 45%; background-repeat: no-repeat; background-size: cover, 24rem; }
.camp-dialog--caravan .camp-dialog__header { background-image: linear-gradient(90deg, #100e0c 30%, rgba(26, 19, 12, .4)), url('/images/game/camp-modular/expansion-stash-wagon.png'); background-position: center, right 40%; background-repeat: no-repeat; background-size: cover, 25rem; }
.camp-dialog--chronicle .camp-dialog__header { background-position: center, 70% 66%; }
.camp-dialog__identity { align-items: center; display: flex; gap: 1rem; min-width: 0; text-shadow: 0 2px 4px #000; }
.camp-dialog__identity :deep(.hero-sprite) { flex: 0 0 auto; height: 8rem; width: 5.3rem; }
.camp-dialog__header h2 { color: #f0c26a; font-family: Georgia, 'Times New Roman', serif; font-size: clamp(1.55rem, 3vw, 2.15rem); letter-spacing: -.02em; margin: 0; }
.camp-dialog__header p { color: #d8c8ae; margin: .25rem 0 0; }
.camp-dialog__close { align-items: center; background: rgba(8, 8, 10, .72); border: 1px solid #80613d; color: #f4e8d2; cursor: pointer; display: flex; flex: 0 0 auto; height: 2.75rem; justify-content: center; width: 2.75rem; }
.camp-dialog__close:hover { background: #2a1d14; border-color: #f0c26a; }
.camp-dialog__close svg { fill: none; height: 1.25rem; stroke: currentColor; stroke-linecap: round; stroke-width: 1.75; width: 1.25rem; }
.camp-dialog :deep(.equipment-v2), .camp-dialog :deep(.v2-cycle), .camp-dialog :deep(.caravan-v2), .camp-dialog :deep(.chronicle) { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 1.5rem; }
.camp-dialog :deep(.v2-cycle--trade) { flex: 1; overflow: hidden; padding: 0; }
.camp-dialog--tavern :deep(.v2-cycle__body) { grid-template-columns: minmax(0, 1fr); }
.camp-dialog--tavern :deep(.v2-cycle__panel) { background: transparent; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 0 0 1.25rem; }
.camp-dialog--tavern :deep(.v2-cycle__row) { background: transparent; border: 0; border-top: 1px solid var(--line); border-radius: 0; padding: .85rem 0; }
.camp-dialog--caravan :deep(.caravan-hero) { display: none; }
.camp-dialog--caravan :deep(.caravan-v2) { width: 100%; }
.camp-dialog--caravan :deep(.stat), .camp-dialog--caravan :deep(.upgrade-card), .camp-dialog--caravan :deep(.actions-card) { background: transparent; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; }
.camp-dialog--caravan :deep(.stat) { padding: .75rem 0; }
.camp-dialog--caravan :deep(.upgrade-card) { padding: 1rem .5rem; }
.camp-dialog--caravan :deep(.actions-card) { padding-inline: 0; }
.camp-dialog--chronicle :deep(.timeline-entry) { background: transparent; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: .85rem 0; }
.camp-dialog--chronicle :deep(.chronicle > .section-title .eyebrow) { display: none; }
.camp-dialog--equipment :deep(.equipment-v2 .section-title .eyebrow), .camp-dialog--equipment :deep(.equipment-v2 .section-title .tag) { display: none; }

@keyframes dialog-enter { from { opacity: 0; transform: translateY(.75rem) scale(.985); } }

@media (max-width: 900px) {
  .game-home { padding-inline: .5rem; }
  .camp-stage { aspect-ratio: 1672 / 941; min-height: 0; width: 100%; }
  .camp-background { object-fit: contain; }
  .camp-hud { background: #0c0b0a; flex-direction: column; padding: .75rem; position: static; }
  .camp-title-block { background: transparent; padding: 0; }
  .camp-resources { justify-content: start; }
  .camp-resources span:nth-child(2), .camp-resources span:nth-child(3) { display: none; }
  .camp-place small { display: none; }
  .camp-place::after { height: 2.3rem; }
  .next-order { border-inline: 0; bottom: auto; left: auto; max-width: none; position: static; }
  .hero-dock { height: 7rem; overflow-x: auto; padding-inline: .5rem; position: static; }
  .hero-portrait { flex: 0 0 8.5rem; }
  .hero-portrait :deep(.hero-sprite) { height: 5rem; width: 3.4rem; }
}

@media (max-width: 560px) {
  .camp-title-block p { display: none; }
  .camp-place { padding: .3rem; }
  .camp-place::after { bottom: .15rem; height: 1.75rem; inset-inline: .15rem; }
  .camp-place span { font-size: .72rem; }
  .next-order { align-items: center; gap: .45rem; }
  .next-order span { display: none; }
  .next-order button { text-align: center; }
  .camp-dialog { max-height: 94dvh; width: calc(100% - 1rem); }
  .camp-dialog--trade { height: 94dvh; }
  .camp-dialog__header { min-height: 5rem; padding: .75rem; }
  .camp-dialog__identity { gap: .65rem; }
  .camp-dialog__identity :deep(.hero-sprite) { height: 5.5rem; width: 3.7rem; }
  .camp-dialog :deep(.equipment-v2), .camp-dialog :deep(.v2-cycle), .camp-dialog :deep(.caravan-v2), .camp-dialog :deep(.chronicle) { padding: .75rem; }
  .camp-dialog :deep(.v2-cycle--trade) { padding: 0; }
}

@media (prefers-reduced-motion: reduce) { .camp-dialog { animation: none; } }
</style>

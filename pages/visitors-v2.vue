<template>
  <main class="page visitors-v2-page">
    <header class="section-title">
      <div>
        <h1>Visitantes V2</h1>
        <p class="muted">Contratos, expediciones y recuperaciones confirmados por el servidor.</p>
      </div>
    </header>

    <VisitorCycleV2
      :game="game.game"
      :load-state="game.loadState"
      :operation-state="game.operationState"
      :error-message="game.errorMessage"
      :unavailable-reason="game.unavailableReason"
      :snapshot-stale="game.snapshotStale"
      @accept-contract="game.acceptContract"
      @start-expedition="game.startExpedition"
      @reconcile-game="game.reconcileGame"
      @confirm-settlement="game.confirmSettlement"
      @assign-recovery="game.assignRecovery"
      @abandon-recovery="game.abandonRecovery"
      @retry="game.retryUncertain"
      @reload="game.retryConflictReload"
    />
  </main>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import VisitorCycleV2 from '~/components/VisitorCycleV2.vue'
import { useGameV2Store } from '~/stores/game-v2'

const game = useGameV2Store()

onMounted(() => { void game.load() })
</script>

<style scoped>
.visitors-v2-page { display: grid; gap: 1.25rem; }
.section-title h1, .section-title p { margin: 0; }
</style>

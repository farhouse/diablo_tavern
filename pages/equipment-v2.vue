<template>
  <main class="page equipment-page">
    <header class="section-title"><div><span class="eyebrow">Diablo Tavern · V2</span><h1>Equipo y servicios</h1><p class="muted">Inspeccioná el stash y enviá trabajos usando sólo autorizaciones del snapshot.</p></div><button class="btn ghost" type="button" :disabled="gameV2.loadState === 'loading'" @click="reload">{{ gameV2.loadState === 'loading' ? 'Actualizando…' : 'Actualizar' }}</button></header>
    <EquipmentV2 :game="gameV2.game" :load-state="gameV2.loadState" :operation-state="gameV2.operationState" :error-message="gameV2.errorMessage" :unavailable-reason="gameV2.unavailableReason" :snapshot-stale="gameV2.snapshotStale" @reload="reload" @retry="gameV2.retryEquipmentUncertain" @action="gameV2.runEquipmentAction" />
  </main>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import EquipmentV2 from '~/components/EquipmentV2.vue'
import { useGameV2Store } from '~/stores/game-v2'

const gameV2 = useGameV2Store()
onMounted(() => { if (!gameV2.game) void gameV2.load() })
async function reload() {
  if (gameV2.snapshotStale) await gameV2.retryConflictReload()
  else await gameV2.load()
}
</script>

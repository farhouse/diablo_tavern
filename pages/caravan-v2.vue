<template><main class="page"><header class="section-title"><div><h1>Caravana</h1><p class="muted">Consultá la capacidad, la manutención y las mejoras disponibles.</p></div><button class="btn ghost" type="button" :disabled="game.loadState === 'loading'" @click="reload">{{ game.loadState === 'loading' ? 'Actualizando…' : 'Actualizar' }}</button></header><CaravanV2 :game="game.game" :load-state="game.loadState" :operation-state="game.operationState" :error-message="game.errorMessage" :unavailable-reason="game.unavailableReason" :snapshot-stale="game.snapshotStale" @reload="reload" @retry="game.retryUncertain" @upgrade="game.upgradeCaravan" /></main></template>
<script setup lang="ts">
import { onMounted } from 'vue'
import CaravanV2 from '~/components/CaravanV2.vue'
import { useGameV2Store } from '~/stores/game-v2'
const game = useGameV2Store()
onMounted(() => { if (!game.game) void game.load() })
async function reload() { if (game.snapshotStale) await game.retryConflictReload(); else await game.load() }
</script>

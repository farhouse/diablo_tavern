<template><main class="page"><header class="section-title"><div><h1>Crónica V2</h1><p class="muted">Un registro de eventos publicados por la caravana.</p></div><button class="btn ghost" type="button" :disabled="chronicle.loadState === 'loading'" @click="chronicle.load">{{ chronicle.loadState === 'loading' ? 'Actualizando…' : 'Actualizar' }}</button></header><ChronicleV2 :entries="chronicle.entries" :load-state="chronicle.loadState" :error-message="chronicle.errorMessage" :load-more-state="chronicle.loadMoreState" :load-more-error="chronicle.loadMoreError" :has-more="chronicle.hasMore" @reload="chronicle.load" @load-more="chronicle.loadMore" /></main></template>
<script setup lang="ts">
import { onMounted } from 'vue'
import ChronicleV2 from '~/components/ChronicleV2.vue'
import { useChronicleV2Store } from '~/stores/chronicle-v2'
const chronicle = useChronicleV2Store()
onMounted(() => { void chronicle.load() })
</script>

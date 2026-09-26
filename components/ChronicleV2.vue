<template>
  <section class="chronicle" aria-labelledby="chronicle-title">
    <div v-if="loadState === 'loading'" class="card state" aria-busy="true">Cargando crónica…</div>
    <div v-else-if="loadState === 'error'" class="card state" role="alert"><h2>No se pudo abrir la crónica</h2><p>{{ errorMessage }}</p><button class="btn primary" type="button" @click="$emit('reload')">Reintentar carga</button></div>
    <template v-else>
      <div class="section-title"><div><span class="eyebrow">Registro del campamento</span><h2 id="chronicle-title">Crónica histórica</h2><p class="muted">Los hechos están ordenados por el servidor. Este registro no modifica la partida.</p></div><span class="tag">{{ entries.length }} entradas</span></div>
      <div v-if="!entries.length" class="card state"><h3>La crónica todavía está vacía</h3><p class="muted">Los próximos eventos aparecerán aquí cuando se publiquen.</p></div>
      <ol v-else class="timeline" aria-live="polite"><li v-for="entry in entries" :key="entry.eventId" class="card timeline-entry"><div class="timeline-dot" aria-hidden="true" /><div class="row"><strong>{{ entry.text.fallback }}</strong><time :datetime="entry.occurredAt">{{ formatDate(entry.occurredAt) }}</time></div><p class="muted">{{ subjectLabel(entry) }}</p><p v-if="entry.itemProvenance" class="provenance">Procedencia: {{ entry.itemProvenance.zoneId ?? 'zona desconocida' }}<span v-if="entry.itemProvenance.lootTableId"> · {{ entry.itemProvenance.lootTableId }}</span></p></li></ol>
      <div v-if="loadMoreError" class="page-alert page-alert--error" role="alert"><span>{{ loadMoreError }}</span><button class="btn" type="button" @click="$emit('load-more')">Reintentar</button></div>
      <button v-if="hasMore" class="btn load-more" type="button" :disabled="loadMoreState === 'loading'" @click="$emit('load-more')">{{ loadMoreState === 'loading' ? 'Cargando…' : 'Cargar entradas anteriores' }}</button>
      <p v-else-if="entries.length" class="muted end-note">Fin de la crónica publicada.</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import type { ChronicleEntry } from '~/shared/types/v2-chronicle'
defineProps<{ entries: ChronicleEntry[]; loadState: string; errorMessage: string; loadMoreState: string; loadMoreError: string; hasMore: boolean }>()
defineEmits<{ reload: []; 'load-more': [] }>()
function formatDate(value: string) { return new Date(value).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' }) }
function subjectLabel(entry: ChronicleEntry) { return `${entry.subject.kind === 'visitor' ? 'Visitante' : entry.subject.kind === 'expedition' ? 'Expedición' : 'Objeto'} · ${entry.subject.id}` }
</script>

<style scoped>
.chronicle { display: grid; gap: 1rem; }
.timeline { display: grid; gap: .75rem; list-style: none; margin: 0; padding: 0; }
.timeline-entry { display: grid; gap: .45rem; position: relative; }
.timeline-entry::before { background: var(--line); content: ''; height: 100%; left: 1.3rem; position: absolute; top: 1.5rem; width: 1px; }
.timeline-entry:last-child::before { display: none; }
.timeline-dot { background: var(--accent-2); border: 3px solid var(--panel); border-radius: 50%; height: .8rem; left: .9rem; position: absolute; top: 1.15rem; width: .8rem; z-index: 1; }
.timeline-entry > *:not(.timeline-dot) { margin-left: 1.5rem; }
.timeline-entry p { margin: 0; }
.timeline-entry time { color: var(--muted); font-size: .85rem; }
.provenance { color: var(--accent-2); font-size: .9rem; }
.load-more { justify-self: center; min-width: 13rem; }
.end-note { text-align: center; }
.state { display: grid; gap: .5rem; justify-items: start; }
.state h2, .state h3, .state p { margin: 0; }
@media (max-width: 560px) { .timeline-entry .row { align-items: flex-start; flex-direction: column; } }
</style>

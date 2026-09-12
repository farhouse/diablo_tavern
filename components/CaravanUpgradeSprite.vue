<template>
  <img
    class="pixel-sprite caravan-upgrade-sprite"
    :src="caravanSpriteByUpgrade[upgradeId]"
    :alt="alt"
    width="320"
    height="240"
    loading="lazy"
    decoding="async"
  >
</template>

<script setup lang="ts">
import { caravanSpriteByUpgrade, type CaravanSpriteId } from '~/utils/game-assets'

withDefaults(defineProps<{
  upgradeId: CaravanSpriteId
  alt?: string
}>(), { alt: '' })
</script>

<style scoped>
.caravan-upgrade-sprite {
  aspect-ratio: 4 / 3;
  flex: 0 0 9rem;
  height: 6.75rem;
  object-fit: contain;
  object-position: center bottom;
  width: 9rem;
}

@media (max-width: 600px) {
  .caravan-upgrade-sprite {
    align-self: center;
    height: 8.25rem;
    width: 11rem;
  }
}
</style>

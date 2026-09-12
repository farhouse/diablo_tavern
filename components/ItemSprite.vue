<template>
  <img
    class="pixel-sprite item-sprite"
    :src="itemSpriteByType[itemType]"
    :alt="alt"
    width="72"
    height="72"
    loading="lazy"
    decoding="async"
  >
</template>

<script setup lang="ts">
import type { ItemType } from '~/types/game'
import { itemSpriteByType } from '~/utils/game-assets'

withDefaults(defineProps<{
  itemType: ItemType
  alt?: string
}>(), { alt: '' })
</script>

<style scoped>
.item-sprite {
  flex: 0 0 auto;
  height: 72px;
  object-fit: contain;
  width: 72px;
}
</style>

<template>
  <img
    class="pixel-sprite hero-sprite"
    :src="heroSpriteByClass[heroClass]"
    :alt="alt ?? `${heroClassLabel[heroClass]} hero`"
    width="46"
    height="70"
    decoding="async"
  >
</template>

<script setup lang="ts">
import type { HeroClass } from '~/types/game'
import { heroClassLabel, heroSpriteByClass } from '~/utils/game-assets'

defineProps<{
  heroClass: HeroClass
  alt?: string
}>()
</script>

<style scoped>
.hero-sprite {
  flex: 0 0 auto;
  height: 70px;
  object-fit: contain;
  width: 46px;
}
</style>

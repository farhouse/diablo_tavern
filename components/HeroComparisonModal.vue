<template>
  <Teleport to="body">
    <div class="modal-overlay" @click="close">
      <div class="modal-container" @click.stop>
        <div class="modal-header">
          <h2>Hero Class Comparison</h2>
          <button class="modal-close" @click="close">×</button>
        </div>
        
        <div class="modal-body">
          <div class="comparison-grid">
            <div v-for="hero in comparisonHeroes" :key="hero.class" class="hero-comparison-card">
              <div class="hero-header">
                <h3>{{ hero.label }}</h3>
                <span class="hero-role" :class="hero.role">{{ hero.role }}</span>
              </div>
              
              <div class="hero-stats">
                <div class="stat-section">
                  <h4>Base Stats</h4>
                  <div class="stat-row">
                    <span>Strength</span>
                    <span class="stat-value">{{ hero.baseStats.strength }}</span>
                  </div>
                  <div class="stat-row">
                    <span>Dexterity</span>
                    <span class="stat-value">{{ hero.baseStats.dexterity }}</span>
                  </div>
                  <div class="stat-row">
                    <span>Vitality</span>
                    <span class="stat-value">{{ hero.baseStats.vitality }}</span>
                  </div>
                  <div class="stat-row">
                    <span>Energy</span>
                    <span class="stat-value">{{ hero.baseStats.energy }}</span>
                  </div>
                </div>
                
                <div class="stat-section">
                  <h4>Derived Stats (Level 1)</h4>
                  <div class="stat-row">
                    <span>Life</span>
                    <span class="stat-value">{{ hero.derivedStats.life }}</span>
                  </div>
                  <div class="stat-row">
                    <span>Mana</span>
                    <span class="stat-value">{{ hero.derivedStats.mana }}</span>
                  </div>
                  <div class="stat-row">
                    <span>Attack Power</span>
                    <span class="stat-value">{{ hero.derivedStats.attackPower }}</span>
                  </div>
                  <div class="stat-row">
                    <span>Defense</span>
                    <span class="stat-value">{{ hero.derivedStats.defense }}</span>
                  </div>
                </div>
                
                <div class="stat-section">
                  <h4>Role & Description</h4>
                  <p class="hero-description">{{ hero.description }}</p>
                  <div class="role-indicator" :class="hero.role">
                    {{ hero.role }} role
                  </div>
                </div>
              </div>
              
              <div class="hero-actions">
                <button 
                  class="btn primary hire-btn" 
                  @click="hireHero(hero.class)"
                  :disabled="!canAfford(hero.class)"
                >
                  Hire {{ hero.label }}
                </button>
                <button class="btn ghost" @click="viewHeroDetails(hero.class)">
                  View Details
                </button>
              </div>
            </div>
          </div>
        </div>
        
        <div class="modal-footer">
          <button class="btn ghost" @click="close">Cancel</button>
          <div class="recommendation" v-if="recommendation">
            <span class="recommended-label">Recommended:</span>
            <span class="recommended-hero">{{ recommendation.label }}</span>
          </div>
        </div>
      </div>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { HeroClass } from '~/types/game'
import { heroClassStats } from '~/utils/game-data'
import { createHero, getHireCost } from '~/utils/game-logic'

interface ComparisonHero {
  class: HeroClass
  label: string
  baseStats: { strength: number; dexterity: number; vitality: number; energy: number }
  derivedStats: { life: number; mana: number; attackPower: number; defense: number }
  role: string
  description: string
}

const props = defineProps({
  currentParty: { type: Array as () => string[], default: () => [] },
  playerGold: { type: Number, default: 0 },
  onClose: { type: Function, required: true },
  onHire: { type: Function, required: true }
})

const emit = defineEmits(['close', 'hire'])

const comparisonHeroes = ref<ComparisonHero[]>([])
const recommendation = ref<ComparisonHero | null>(null)

const heroCap = ref(3)
const activeHeroCount = ref(0)

onMounted(() => {
  // Prepare comparison data
  comparisonHeroes.value = Object.entries(heroClassStats).map(([classKey, stats]) => {
    const heroClass = classKey as HeroClass
    const hero = createHero(heroClass)
    
    return {
      class: heroClass,
      label: stats.label,
      baseStats: hero.baseStats,
      derivedStats: hero.derivedStats,
      role: getRole(heroClass),
      description: getDescription(heroClass)
    }
  })
  
  // Calculate recommendation based on current party
  calculateRecommendation()
})

function getRole(heroClass: HeroClass): string {
  const roles: Record<HeroClass, string> = {
    barbarian: 'Frontline',
    sorceress: 'Damage',
    paladin: 'Defense',
    necromancer: 'Balanced'
  }
  return roles[heroClass]
}

function getDescription(heroClass: HeroClass): string {
  const descriptions: Record<HeroClass, string> = {
    barbarian: 'High life and physical attack.',
    sorceress: 'High mana and burst power, low defense.',
    paladin: 'Strong vitality and reliable defenses.',
    necromancer: 'Flexible stats with strong energy growth.'
  }
  return descriptions[heroClass]
}

function calculateRecommendation() {
  if (activeHeroCount.value >= heroCap.value) {
    recommendation.value = null
    return
  }
  
  // Simple recommendation logic - can be enhanced later
  const hireCosts = comparisonHeroes.value.map(hero => ({
    ...hero,
    cost: getHireCost({ gold: playerGold.value, materials: 0, caravan: { level: 0, upgrades: { wagons: 0, scoutTable: 0, stashWagon: 0, infirmary: 0, appraiser: 0 }, services: { appraiserQueue: [] } }, stashLimit: 20, heroes: [], stash: [], pendingLoot: [], questsProgress: [], activeQuestRun: undefined, lastQuestRun: undefined, activeExpeditions: [], expeditionHistory: [], createdAt: '', updatedAt: '' })
  })).sort((a, b) => a.cost - b.cost)
  
  recommendation.value = hireCosts[0] || null
}

function canAfford(heroClass: HeroClass): boolean {
  const hero = comparisonHeroes.value.find(h => h.class === heroClass)
  if (!hero) return false
  
  const cost = getHireCost({ gold: props.playerGold, materials: 0, caravan: { level: 0, upgrades: { wagons: 0, scoutTable: 0, stashWagon: 0, infirmary: 0, appraiser: 0 }, services: { appraiserQueue: [] } }, stashLimit: 20, heroes: [], stash: [], pendingLoot: [], questsProgress: [], activeQuestRun: undefined, lastQuestRun: undefined, activeExpeditions: [], expeditionHistory: [], createdAt: '', updatedAt: '' })
  return props.playerGold >= cost
}

function hireHero(heroClass: HeroClass) {
  if (!canAfford(heroClass)) return
  emit('hire', heroClass)
  close()
}

function viewHeroDetails(heroClass: HeroClass) {
  // Navigate to hero details page
  window.location.href = `/heroes/${heroClass}-details`
}

function close() {
  emit('close')
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
  animation: fadeIn 0.2s ease;
}

.modal-container {
  background: var(--surface);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  max-width: 900px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  position: relative;
  animation: slideUp 0.3s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideUp {
  from { 
    opacity: 0;
    transform: translateY(20px);
  }
  to { 
    opacity: 1;
    transform: translateY(0);
  }
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.5rem;
  border-bottom: 1px solid var(--border);
}

.modal-header h2 {
  margin: 0;
  font-size: 1.5rem;
  color: var(--text-primary);
  font-weight: 600;
}

.modal-close {
  background: none;
  border: none;
  font-size: 1.5rem;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 0.5rem;
  border-radius: 4px;
  transition: all 0.2s ease;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-close:hover {
  background: var(--background-hover);
  color: var(--text-primary);
  transform: rotate(90deg);
}

.modal-body {
  padding: 1.5rem;
}

.comparison-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.5rem;
}

.hero-comparison-card {
  background: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--border);
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  transition: all 0.2s ease;
}

.hero-comparison-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  border-color: var(--primary);
}

.hero-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 0.5rem;
}

.hero-header h3 {
  margin: 0;
  font-size: 1.25rem;
  color: var(--text-primary);
  font-weight: 600;
}

.hero-role {
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.hero-role.frontline {
  background: #ff6b6b;
  color: white;
}

.hero-role.damage {
  background: #4dabf7;
  color: white;
}

.hero-role.defense {
  background: #51cf66;
  color: white;
}

.hero-role.balanced {
  background: #ffd43b;
  color: #000;
}

.hero-stats {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.stat-section {
  background: var(--background);
  padding: 0.75rem;
  border-radius: 6px;
}

.stat-section h4 {
  margin: 0 0 0.5rem 0;
  font-size: 0.875rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.stat-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.25rem;
  font-size: 0.875rem;
}

.stat-value {
  font-weight: 600;
  color: var(--text-primary);
}

.hero-description {
  margin: 0.5rem 0;
  font-size: 0.875rem;
  color: var(--text-secondary);
  line-height: 1.4;
}

.role-indicator {
  display: inline-block;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  margin-top: 0.5rem;
  background: var(--background-hover);
}

.hero-actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: auto;
}

.hire-btn {
  width: 100%;
  transition: all 0.2s ease;
}

.hire-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
}

.hire-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.modal-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.5rem;
  border-top: 1px solid var(--border);
}

.recommendation {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  padding: 0.75rem 1rem;
  background: var(--background-hover);
  border-radius: 6px;
}

.recommended-label {
  color: var(--text-secondary);
  font-weight: 500;
}

.recommended-hero {
  font-weight: 600;
  color: var(--primary);
}

@media (max-width: 768px) {
  .comparison-grid {
    grid-template-columns: 1fr;
  }
  
  .modal-container {
    max-height: 95vh;
    margin: 0.5rem;
  }
  
  .modal-header {
    padding: 1rem;
  }
  
  .modal-body {
    padding: 1rem;
  }
  
  .modal-footer {
    padding: 1rem;
    flex-direction: column;
    gap: 1rem;
    align-items: flex-start;
  }
}
</style>

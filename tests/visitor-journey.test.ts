import { describe, expect, it } from 'vitest'
import type { VisitorCommission } from '../types/game'
import { getVisitorJourneyMilestones } from '../utils/visitor-journey'

function commission(overrides: Partial<VisitorCommission> = {}): VisitorCommission {
  return {
    id: 'commission-1', optionId: 'safe', title: 'Careful patrol', regionId: 'blood-moor',
    durationMs: 100_000, successChance: 0.82, fullRewardGold: 54, partialRewardGold: 18,
    riskLevel: 'low', failureConsequence: 'No reward.', status: 'active',
    startedAt: '2026-09-10T20:00:00.000Z', finishesAt: '2026-09-10T20:01:40.000Z',
    outcomeRoll: 0.01, ...overrides
  }
}

describe('visitor journey milestones', () => {
  it('reveals stable milestones from persisted time progress', () => {
    const active = commission()

    expect(getVisitorJourneyMilestones(active, new Date('2026-09-10T20:00:24.000Z').getTime()))
      .toHaveLength(1)
    expect(getVisitorJourneyMilestones(active, new Date('2026-09-10T20:00:55.000Z').getTime())
      .map((entry) => entry.title)).toEqual(['Set out', 'Crossed into the Blood Moor', 'A measured advance'])

    const reloaded = structuredClone(active)
    expect(getVisitorJourneyMilestones(reloaded, new Date('2026-09-10T20:00:55.000Z').getTime()))
      .toEqual(getVisitorJourneyMilestones(active, new Date('2026-09-10T20:00:55.000Z').getTime()))
  })

  it('changes the narrative by route and commission type without reading the sealed result', () => {
    const risky = commission({
      optionId: 'risky', title: 'Perilous delve', regionId: 'forgotten-tower', riskLevel: 'high',
      outcomeRoll: 0.01
    })
    const differentSealedRoll = { ...risky, outcomeRoll: 0.99, outcome: 'failed' as const }
    const now = new Date('2026-09-10T20:01:25.000Z').getTime()
    const milestones = getVisitorJourneyMilestones(risky, now)

    expect(milestones.map((entry) => entry.title)).toEqual([
      'Set out', 'Reached the Forgotten Tower', 'Pressed into danger', 'Turned for the tavern'
    ])
    expect(milestones.some((entry) => entry.description.includes('tower'))).toBe(true)
    expect(getVisitorJourneyMilestones(differentSealedRoll, now)).toEqual(milestones)
  })

  it('clamps malformed timing to the first milestone', () => {
    expect(getVisitorJourneyMilestones(commission({ startedAt: 'invalid' }), Date.now()))
      .toHaveLength(1)
  })
})

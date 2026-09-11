import { describe, expect, it } from 'vitest'
import type { VisitorCommission } from '../types/game'
import {
  getVisitorJourneyMilestones,
  getVisitorJourneyProgress,
  type VisitorJourneySource
} from '../utils/visitor-journey'

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
  const regions = [
    ['blood-moor', 'Crossed into the Blood Moor'],
    ['den-of-evil', 'Reached the Den of Evil'],
    ['cold-plains', 'Entered the Cold Plains'],
    ['burial-grounds', 'Reached the Burial Grounds'],
    ['forgotten-tower', 'Reached the Forgotten Tower'],
    ['catacombs', 'Entered the Catacombs'],
    ['act-boss', 'Reached the inner sanctum']
  ] as const

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

  it.each(regions.flatMap(([regionId, arrivalTitle]) => [
    { regionId, arrivalTitle, optionId: 'safe' as const, encounterTitle: 'A measured advance', routeWord: 'careful' },
    { regionId, arrivalTitle, optionId: 'risky' as const, encounterTitle: 'Pressed into danger', routeWord: 'perilous' }
  ]))('covers $regionId/$optionId without leaking sealed data', ({ regionId, arrivalTitle, optionId, encounterTitle, routeWord }) => {
    const allowed = new Set(['startedAt', 'finishesAt', 'regionId', 'optionId'])
    const reads = new Set<string>()
    const source = new Proxy({
      startedAt: '2026-09-10T20:00:00.000Z',
      finishesAt: '2026-09-10T20:01:40.000Z',
      regionId,
      optionId
    }, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          if (!allowed.has(property)) throw new Error(`Journey leaked unauthorized field: ${property}`)
          reads.add(property)
        }
        return Reflect.get(target, property, receiver)
      }
    }) as VisitorJourneySource
    const now = new Date('2026-09-10T20:01:40.000Z').getTime()

    expect(getVisitorJourneyProgress(source, now)).toBe(1)
    const milestones = getVisitorJourneyMilestones(source, now)

    expect(milestones.map(({ title }) => title)).toEqual([
      'Set out', arrivalTitle, encounterTitle, 'Turned for the tavern'
    ])
    expect(milestones[0]?.description).toContain(routeWord)
    expect(reads).toEqual(allowed)
  })

  it.each([
    [0, 1],
    [0.25, 2],
    [0.5, 3],
    [0.8, 4],
    [1, 4]
  ])('reveals the expected reports at %s progress', (progress, reportCount) => {
    const active = commission()
    const startedAt = new Date(active.startedAt).getTime()

    expect(getVisitorJourneyProgress(active, startedAt + active.durationMs * progress)).toBe(progress)
    expect(getVisitorJourneyMilestones(active, startedAt + active.durationMs * progress)).toHaveLength(reportCount)
  })

  it.each([
    ['invalid start', { startedAt: 'invalid' }, Date.now()],
    ['invalid finish', { finishesAt: 'invalid' }, Date.now()],
    ['equal timestamps', { finishesAt: '2026-09-10T20:00:00.000Z' }, Date.now()],
    ['reversed timestamps', { finishesAt: '2026-09-10T19:59:59.000Z' }, Date.now()],
    ['invalid current time', {}, Number.NaN],
    ['invalid start and current time', { startedAt: 'invalid' }, Number.NaN]
  ])('falls back safely for %s', (_label, overrides, now) => {
    const active = commission(overrides)

    expect(getVisitorJourneyProgress(active, now)).toBe(0)
    expect(getVisitorJourneyMilestones(active, now)).toHaveLength(1)
  })
})

import type { VisitorCommission } from '~/types/game'

export type VisitorJourneySource = Pick<VisitorCommission, 'startedAt' | 'finishesAt' | 'regionId' | 'optionId'>

export interface VisitorJourneyMilestone {
  id: 'departure' | 'arrival' | 'encounter' | 'return'
  title: string
  description: string
  reachedAt: string
}

interface RouteNarrative {
  arrivalTitle: string
  arrival: string
  safe: string
  risky: string
  return: string
}

const ROUTES: Record<string, RouteNarrative> = {
  'blood-moor': {
    arrivalTitle: 'Crossed into the Blood Moor',
    arrival: 'The last trail marks led out across the open moor.',
    safe: 'The traveler kept to the old paths and watched for signs of hostile forces.',
    risky: 'The traveler left the road to press through ground where hostile forces gather.',
    return: 'A tavern-bound marker was found at the edge of the moor.'
  },
  'den-of-evil': {
    arrivalTitle: 'Reached the Den of Evil',
    arrival: 'A soot-marked sign was left beside the den entrance.',
    safe: 'The traveler searched the outer passages for tracks and a defensible route.',
    risky: 'The traveler pushed into the dark passages where echoes conceal movement.',
    return: 'A fresh trail now leads back from the den toward the tavern.'
  },
  'cold-plains': {
    arrivalTitle: 'Entered the Cold Plains',
    arrival: 'The trail continued beyond the pass and into the wind-scoured plains.',
    safe: 'The traveler followed sheltered ground and paused at a safe haven.',
    risky: 'The traveler crossed exposed ground where distant shapes shadowed the route.',
    return: 'A cairn on the homeward trail carries the traveler’s mark.'
  },
  'burial-grounds': {
    arrivalTitle: 'Reached the Burial Grounds',
    arrival: 'The traveler marked the old gate before moving among the graves.',
    safe: 'The traveler circled the grounds, reading tracks without disturbing the tombs.',
    risky: 'The traveler pressed between opened crypts where the dead do not rest quietly.',
    return: 'The latest marker points away from the graves and back to the tavern.'
  },
  'forgotten-tower': {
    arrivalTitle: 'Reached the Forgotten Tower',
    arrival: 'A charcoal mark appeared on stone near the ruined tower.',
    safe: 'The traveler searched the lower halls and tested each stair before climbing.',
    risky: 'The traveler climbed past broken wards toward the tower’s deeper danger.',
    return: 'A fresh mark at the ruined gate signals the homeward road.'
  },
  catacombs: {
    arrivalTitle: 'Entered the Catacombs',
    arrival: 'A wax-sealed trail mark was left inside the catacomb doors.',
    safe: 'The traveler mapped the outer vaults and avoided the loudest passages.',
    risky: 'The traveler descended beyond the mapped vaults where old traps still wait.',
    return: 'The last sign points up from the vaults toward open ground.'
  },
  'act-boss': {
    arrivalTitle: 'Reached the inner sanctum',
    arrival: 'The final waystone bears the traveler’s mark outside the inner sanctum.',
    safe: 'The traveler studied the chamber approaches for evidence of the enemy’s presence.',
    risky: 'The traveler crossed the last threshold where a powerful foe guards the way.',
    return: 'A final marker was set on the road leading back to the tavern.'
  }
}

const FALLBACK_ROUTE: RouteNarrative = {
  arrivalTitle: 'Reached the commission grounds',
  arrival: 'The traveler left a route marker at the edge of the region.',
  safe: 'The traveler advanced carefully, watching the path for hostile signs.',
  risky: 'The traveler pressed beyond the safer path into uncertain ground.',
  return: 'The latest route marker points back toward the tavern.'
}

const THRESHOLDS = [0, 0.25, 0.5, 0.8] as const

export function getVisitorJourneyProgress(commission: VisitorJourneySource, now: number): number {
  const startedAt = new Date(commission.startedAt).getTime()
  const finishesAt = new Date(commission.finishesAt).getTime()
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishesAt) || !Number.isFinite(now) || finishesAt <= startedAt) return 0
  return Math.min(1, Math.max(0, (now - startedAt) / (finishesAt - startedAt)))
}

export function getVisitorJourneyMilestones(commission: VisitorJourneySource, now: number): VisitorJourneyMilestone[] {
  const route = ROUTES[commission.regionId] ?? FALLBACK_ROUTE
  const startedAt = new Date(commission.startedAt).getTime()
  const finishesAt = new Date(commission.finishesAt).getTime()
  const validTiming = Number.isFinite(startedAt) && Number.isFinite(finishesAt) && finishesAt > startedAt
  const progress = validTiming ? getVisitorJourneyProgress(commission, now) : 0
  const fallbackAt = Number.isFinite(startedAt) ? startedAt : Number.isFinite(now) ? now : 0
  const reachedAt = (threshold: number) => new Date(validTiming
    ? startedAt + (finishesAt - startedAt) * threshold
    : fallbackAt).toISOString()

  const milestones: VisitorJourneyMilestone[] = [
    {
      id: 'departure', title: 'Set out',
      description: `The traveler left the tavern on the ${commission.optionId === 'risky' ? 'perilous' : 'careful'} route.`,
      reachedAt: reachedAt(THRESHOLDS[0])
    },
    { id: 'arrival', title: route.arrivalTitle, description: route.arrival, reachedAt: reachedAt(THRESHOLDS[1]) },
    {
      id: 'encounter', title: commission.optionId === 'risky' ? 'Pressed into danger' : 'A measured advance',
      description: route[commission.optionId], reachedAt: reachedAt(THRESHOLDS[2])
    },
    { id: 'return', title: 'Turned for the tavern', description: route.return, reachedAt: reachedAt(THRESHOLDS[3]) }
  ]

  return milestones.filter((_, index) => progress >= THRESHOLDS[index]!)
}

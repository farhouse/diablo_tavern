import type { UnavailableReason } from '../types/v2-game-view'

export class V2DomainRuleError extends Error {
  override name = 'V2DomainRuleError'

  constructor(message: string, public readonly unavailableReason?: UnavailableReason) {
    super(message)
  }
}

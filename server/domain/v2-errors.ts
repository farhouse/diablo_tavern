import type { UnavailableReason } from '~/shared/types/v2-game-view'

export class ActionUnavailableError extends Error {
  override name = 'ActionUnavailableError'

  constructor(
    public readonly reason: UnavailableReason,
    message = 'The requested action is unavailable',
    public readonly requestId?: string
  ) {
    super(message)
  }
}

export class UncertainOperationError extends Error {
  override name = 'UncertainOperationError'

  constructor(public readonly requestId: string, options?: ErrorOptions) {
    super('The operation result is uncertain; retry with the same requestId', options)
  }
}

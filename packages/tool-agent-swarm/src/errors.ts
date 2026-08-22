export type SwarmRunFailureKind = 'deadline_exceeded' | 'cancelled' | 'plugin_disposed' | 'state_corrupted'

export class SwarmRunError extends Error {
  override readonly name = 'SwarmRunError'

  constructor(
    readonly kind: SwarmRunFailureKind,
    message: string,
  ) {
    super(message)
  }
}

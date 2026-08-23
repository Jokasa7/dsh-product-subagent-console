import { plannerRpcReasonSchema, type PlannerRpcReason } from '../plan-types.js'

/**
 * Recover only the allowlisted stable reason appended by the client RPC bridge.
 * Host error prose may contain prompts, paths, or Provider details and must never
 * become browser-visible action feedback.
 */
export function plannerActionReason(error: unknown): PlannerRpcReason | undefined {
  if (!(error instanceof Error)) return undefined
  const match = /(?:^|:\s*)([a-z0-9-]{1,64})$/u.exec(error.message.trim())
  if (match === null) return undefined
  const parsed = plannerRpcReasonSchema.safeParse(match[1])
  return parsed.success ? parsed.data : undefined
}

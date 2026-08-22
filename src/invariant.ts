import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.js'

export const name = 'product-subagent-console-invariant'
export const inject = ['productSubagentConsole']

/** Continuously assert relationships owned by the standalone console service. */
export function apply(ctx: Context): void {
  const check = (): void => { ctx.productSubagentConsole.assertIntegrity() }
  check()
  ctx.effect(() => ctx.productSubagentConsole.subscribe(check), 'product-subagent-console: invariant subscription')
}

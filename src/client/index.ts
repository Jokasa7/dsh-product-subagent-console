/** Conversation-level task canvas merging native child sessions and observed external runs. */
import type {
  ClientContext, ISessions, SessionId, SubagentAddress,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  consoleSnapshotSchema,
  LIST_SESSIONS_ENDPOINT,
  PRODUCT_SUBAGENT_CONSOLE_CHANNEL,
} from '../types.js'
import { SubagentWorkbenchView, type SubagentWorkbenchInjected } from './SubagentWorkbenchView.js'
import { en, NS, zh, type ProductSubagentsLocaleKey } from './locales.js'

export type { SubagentWorkbenchInjected, SubagentWorkbenchProps } from './SubagentWorkbenchView.js'
export type { ProductSubagentsLocaleKey } from './locales.js'
export type { WorkbenchNode } from './workbench-model.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    productSubagents: ProductSubagentsLocaleKey
  }
}

export const inject = ['slots', 'locale', 'connection', 'sessions']

/** Register the third conversation tab and its one batched loopback RPC reader. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const sessions = ctx.get('sessions') as unknown as ISessions
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-product-subagent-console: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'subagents',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: (_sessionId: SessionId): SubagentWorkbenchInjected => ({
      async listSessions(parentSessionIds: readonly SessionId[], signal: AbortSignal) {
        const result = await connection.rpc.call(
          PRODUCT_SUBAGENT_CONSOLE_CHANNEL,
          LIST_SESSIONS_ENDPOINT,
          { parentSessionIds: parentSessionIds.map(String) },
          signal,
        )
        if (!result.ok) throw new Error(`product-subagent-console RPC failed: ${result.error.code}`)
        return consoleSnapshotSchema.parse(result.value)
      },
      openChild(address: SubagentAddress) { sessions.openSubagent(address) },
      refreshNative(parentSessionId: SessionId) { return sessions.refreshSubagents(parentSessionId) },
    }),
  }, SubagentWorkbenchView))
}

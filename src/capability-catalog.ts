import type { ExecutionCapabilitySnapshot } from './plan-types.js'

type LlmRoute = ExecutionCapabilitySnapshot['llmRoutes'][number]

export interface CapabilityCatalogOptions {
  readonly concurrency?: number
  readonly perProviderTimeoutMs?: number
  readonly totalTimeoutMs?: number
}

export interface LlmModelInfoLike {
  readonly id: string
}

interface CachedModels {
  readonly expiresAt: number
  readonly models: readonly LlmModelInfoLike[]
}

interface InFlightModels {
  readonly startedAt: number
  readonly promise: Promise<readonly LlmModelInfoLike[]>
}

const DEFAULT_CONCURRENCY = 4
const DEFAULT_PER_PROVIDER_TIMEOUT_MS = 2_000
const DEFAULT_TOTAL_TIMEOUT_MS = 5_000
const DEFAULT_SUCCESS_TTL_MS = 30_000
const DEFAULT_FAILURE_COOLDOWN_MS = 5_000
const DEFAULT_IN_FLIGHT_LEASE_MS = 10_000
const MAX_CATALOG_NAME_LENGTH = 128
const MAX_LLM_PROVIDERS = 128
const MAX_MODELS_PER_PROVIDER = 512

function abortError(): Error {
  const error = new Error('capability catalog request aborted')
  error.name = 'AbortError'
  return error
}

function unavailable(provider: string): LlmRoute {
  return { provider, models: [], catalogStatus: 'unavailable' }
}

function normalizedName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length >= 1 && normalized.length <= MAX_CATALOG_NAME_LENGTH
    ? normalized
    : undefined
}

function normalizedNames(values: readonly unknown[], limit: number): string[] {
  return [...new Set(values.flatMap(value => {
    const normalized = normalizedName(value)
    return normalized === undefined ? [] : [normalized]
  }))].sort().slice(0, limit)
}

/**
 * Reuse model discovery across capability reads. A Provider whose API never
 * settles retains one in-flight call instead of accumulating a new call on
 * every preflight, approval, or execution request.
 */
export class LlmModelCatalogCache {
  private readonly cached = new Map<string, CachedModels>()
  private readonly inFlight = new Map<string, InFlightModels>()
  private readonly failedUntil = new Map<string, number>()

  constructor(
    private readonly successTtlMs = DEFAULT_SUCCESS_TTL_MS,
    private readonly failureCooldownMs = DEFAULT_FAILURE_COOLDOWN_MS,
    private readonly inFlightLeaseMs = DEFAULT_IN_FLIGHT_LEASE_MS,
  ) {}

  load(
    provider: string,
    loader: (providerId: string) => Promise<readonly LlmModelInfoLike[]>,
  ): Promise<readonly LlmModelInfoLike[]> {
    const now = Date.now()
    const cached = this.cached.get(provider)
    if (cached !== undefined && cached.expiresAt > now) return Promise.resolve(cached.models)
    if (cached !== undefined) this.cached.delete(provider)
    const running = this.inFlight.get(provider)
    if (running !== undefined && running.startedAt + Math.max(1, this.inFlightLeaseMs) > now) {
      return running.promise
    }
    if (running !== undefined) this.inFlight.delete(provider)
    if ((this.failedUntil.get(provider) ?? 0) > now) {
      return Promise.reject(new Error('capability catalog provider is cooling down'))
    }
    this.failedUntil.delete(provider)

    const pending = Promise.resolve().then(async () => await loader(provider))
    const record: InFlightModels = { startedAt: now, promise: pending }
    this.inFlight.set(provider, record)
    void pending.then(
      models => {
        if (this.inFlight.get(provider) !== record) return
        this.inFlight.delete(provider)
        this.failedUntil.delete(provider)
        this.cached.set(provider, {
          expiresAt: Date.now() + Math.max(1, this.successTtlMs),
          models,
        })
      },
      () => {
        if (this.inFlight.get(provider) !== record) return
        this.inFlight.delete(provider)
        this.failedUntil.set(provider, Date.now() + Math.max(1, this.failureCooldownMs))
      },
    )
    return pending
  }
}

async function boundedWait<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted === true) throw abortError()
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => { finish(() => { reject(abortError()) }) }
    const timer = setTimeout(() => {
      finish(() => { reject(new Error('capability catalog provider timed out')) })
    }, Math.max(1, timeoutMs))
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { finish(() => { resolve(value) }) },
      error => { finish(() => { reject(error) }) },
    )
  })
}

/**
 * Read advisory model catalogs without letting one Provider block the planner.
 * Provider calls are bounded for waiting purposes; the DSH LLM API does not yet
 * expose a cancellation signal for the underlying listModels operation.
 */
export async function collectLlmRoutes(
  providerIds: readonly string[],
  listModels: (providerId: string) => Promise<readonly LlmModelInfoLike[]>,
  signal?: AbortSignal,
  options: CapabilityCatalogOptions = {},
): Promise<LlmRoute[]> {
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? DEFAULT_CONCURRENCY))
  const perProviderTimeoutMs = Math.max(1, options.perProviderTimeoutMs ?? DEFAULT_PER_PROVIDER_TIMEOUT_MS)
  const totalTimeoutMs = Math.max(1, options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS)
  const providers = normalizedNames(providerIds, MAX_LLM_PROVIDERS)
  const results = providers.map(unavailable)
  const deadline = Date.now() + totalTimeoutMs
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted === true) throw abortError()
      const index = cursor
      cursor += 1
      const provider = providers[index]
      if (provider === undefined) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) continue
      try {
        const models = await boundedWait(
          Promise.resolve().then(async () => await listModels(provider)),
          Math.min(perProviderTimeoutMs, remaining),
          signal,
        )
        const rawModelIds = models.map(model => model.id)
        const normalizedModelIds = normalizedNames(rawModelIds, MAX_MODELS_PER_PROVIDER)
        const complete = rawModelIds.every(model => normalizedName(model) !== undefined)
          && new Set(rawModelIds.map(model => model.trim())).size <= MAX_MODELS_PER_PROVIDER
        results[index] = {
          provider,
          models: normalizedModelIds,
          catalogStatus: complete ? 'available' : 'incomplete',
        }
      } catch (error: unknown) {
        if (signal?.aborted) throw abortError()
        results[index] = unavailable(provider)
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, providers.length) },
    async () => await worker(),
  ))
  return [...results]
}

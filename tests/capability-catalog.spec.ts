import { describe, expect, it, vi } from 'vitest'
import { collectLlmRoutes, LlmModelCatalogCache } from '../src/capability-catalog.js'

describe('bounded LLM capability catalog', () => {
  it('reuses one never-settling Provider lookup across repeated capability reads', async () => {
    const cache = new LlmModelCatalogCache()
    const loader = vi.fn(async () => await new Promise<readonly { id: string }[]>(() => {}))
    const read = async () => await collectLlmRoutes(
      ['slow'],
      async provider => await cache.load(provider, loader),
      undefined,
      { perProviderTimeoutMs: 5, totalTimeoutMs: 10 },
    )

    const [first, second] = await Promise.all([read(), read()])

    expect(first).toEqual([{ provider: 'slow', models: [], catalogStatus: 'unavailable' }])
    expect(second).toEqual(first)
    expect(loader).toHaveBeenCalledOnce()
  })

  it('deduplicates and sorts Providers and models while containing failures', async () => {
    const loader = vi.fn(async (provider: string) => {
      if (provider === 'broken') throw new Error('catalog unavailable')
      return [{ id: 'zeta' }, { id: 'alpha' }, { id: 'alpha' }]
    })

    await expect(collectLlmRoutes(
      ['working', 'broken', 'working'],
      loader,
      undefined,
      { perProviderTimeoutMs: 50, totalTimeoutMs: 100 },
    )).resolves.toEqual([
      { provider: 'broken', models: [], catalogStatus: 'unavailable' },
      { provider: 'working', models: ['alpha', 'zeta'], catalogStatus: 'available' },
    ])
  })

  it('normalizes catalog names and marks truncated or invalid model lists incomplete', async () => {
    const oversized = 'x'.repeat(129)
    const models = Array.from({ length: 513 }, (_, index) => ({ id: `model-${String(index).padStart(3, '0')}` }))
    models.push({ id: '  model-001  ' }, { id: oversized })

    const routes = await collectLlmRoutes(
      ['  provider  ', '', oversized],
      async () => models,
      undefined,
      { perProviderTimeoutMs: 50, totalTimeoutMs: 100 },
    )

    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      provider: 'provider',
      catalogStatus: 'incomplete',
    })
    expect(routes[0]?.models).toHaveLength(512)
    expect(routes[0]?.models[0]).toBe('model-000')
    expect(routes[0]?.models).not.toContain(oversized)
  })

  it('replaces an in-flight lookup after its lease so a Provider can recover', async () => {
    const cache = new LlmModelCatalogCache(30_000, 5_000, 10)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      void cache.load('recovering', async () => await new Promise<readonly { id: string }[]>(() => {}))
      now.mockReturnValue(1_011)
      await expect(cache.load('recovering', async () => [{ id: 'healthy' }]))
        .resolves.toEqual([{ id: 'healthy' }])
    } finally {
      now.mockRestore()
    }
  })

  it('stops waiting when the caller aborts', async () => {
    const controller = new AbortController()
    const pending = collectLlmRoutes(
      ['slow'],
      async () => await new Promise<readonly { id: string }[]>(() => {}),
      controller.signal,
      { perProviderTimeoutMs: 1_000, totalTimeoutMs: 2_000 },
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

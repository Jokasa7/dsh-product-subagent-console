import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'

const MAX_SCHEMA_ERROR_CHARS = 1_000

/** Return the Host engine's exact supported-subset failure without throwing across an RPC boundary. */
export function outputSchemaError(schema: unknown): string | undefined {
  try {
    assertObjectJsonSchema(schema)
    return undefined
  } catch (error: unknown) {
    const message = error instanceof Error && error.message.length > 0
      ? error.message
      : 'schema is outside the supported DSH object-schema subset'
    return message.slice(0, MAX_SCHEMA_ERROR_CHARS)
  }
}

import type { H3Event } from 'h3'

export async function readRequiredBody<T extends Record<string, unknown>>(event: H3Event): Promise<T> {
  const body = await readBody<T>(event)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'Missing request body' })
  }
  return body
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw createError({ statusCode: 400, statusMessage: `${field} is required` })
  }
  return value.trim()
}

/**
 * Same-origin fetch client for the `/vault-api` route registered by the node
 * half. Every call returns the unwrapped `data` payload or throws with the
 * server-provided error message.
 *
 * @module dsh-plugin-vault/client/api
 */

const BASE = '/vault-api'

/** One field of one entry: encrypted fields carry no value. */
export interface FieldMeta {
  enc: boolean
  value?: string
}

/** Whole-vault metadata: entry name -> field name -> field meta. */
export type VaultMeta = Record<string, Record<string, FieldMeta>>

/** One live TOTP reading. */
export interface TotpResult {
  code: string
  remain: number
}

/**
 * Call one API route.
 * @param route - sub-route under `/vault-api` (e.g. `meta`).
 * @param body - JSON body; presence selects POST, absence selects GET.
 * @returns the unwrapped data payload.
 */
export async function api<T>(route: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}/${route}`, body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let json: { ok?: boolean; data?: T; error?: string }
  try {
    json = await res.json() as { ok?: boolean; data?: T; error?: string }
  } catch {
    throw new Error(`vault api: HTTP ${String(res.status)} (non-JSON response)`)
  }
  if (!res.ok || json.ok !== true) throw new Error(json.error ?? `vault api: HTTP ${String(res.status)}`)
  return json.data as T
}

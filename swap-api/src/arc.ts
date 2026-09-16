/**
 * ARC client — broadcasts BIP-239 Extended Format transactions to your own
 * ARC deployment in front of your BSV testnet node.
 *
 *   POST {ARC_URL}/v1/tx          { rawTx: <EF hex> }
 *   GET  {ARC_URL}/v1/tx/{txid}   status / merkle path
 */
import { config } from './config.js'

export interface ArcSubmitResult {
  txid: string
  txStatus: string
  blockHash?: string
  blockHeight?: number
  extraInfo?: string
  status?: number
  title?: string
  detail?: string
  [k: string]: unknown
}

const headers = (): Record<string, string> => {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.arcApiKey) h['Authorization'] = `Bearer ${config.arcApiKey}`
  if (config.arcWaitFor) h['X-WaitFor'] = config.arcWaitFor
  if (config.arcCallbackUrl) h['X-CallbackUrl'] = config.arcCallbackUrl
  return h
}

export const arcSubmit = async (efHex: string): Promise<ArcSubmitResult> => {
  const res = await fetch(`${config.arcUrl}/v1/tx`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ rawTx: efHex }),
  })
  const body = (await res.json().catch(() => ({}))) as ArcSubmitResult
  if (!res.ok && res.status !== 200 && res.status !== 201) {
    throw new ArcError(res.status, body)
  }
  return body
}

export const arcSubmitBatch = async (efHexes: string[]): Promise<ArcSubmitResult[]> => {
  const res = await fetch(`${config.arcUrl}/v1/txs`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(efHexes.map((rawTx) => ({ rawTx }))),
  })
  const body = (await res.json().catch(() => ({}))) as ArcSubmitResult[] | ArcSubmitResult
  if (res.status === 404 || res.status === 405) throw new ArcBatchUnavailableError(res.status)
  if (!res.ok) throw new ArcError(res.status, body as ArcSubmitResult)
  return Array.isArray(body) ? body : [body]
}

export class ArcBatchUnavailableError extends Error {
  constructor(public httpStatus: number) {
    super(`ARC batch endpoint unavailable (${httpStatus})`)
  }
}

export const arcStatus = async (txid: string): Promise<ArcSubmitResult> => {
  const res = await fetch(`${config.arcUrl}/v1/tx/${txid}`, { headers: headers() })
  const body = (await res.json().catch(() => ({}))) as ArcSubmitResult
  if (!res.ok) throw new ArcError(res.status, body)
  return body
}

export class ArcError extends Error {
  constructor(public httpStatus: number, public body: ArcSubmitResult) {
    super(`ARC ${httpStatus}: ${body.title ?? ''} ${body.detail ?? body.extraInfo ?? ''}`.trim())
  }
}

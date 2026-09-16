/**
 * ARC client — broadcasts BIP-239 Extended Format transactions to your own
 * ARC deployment in front of your BSV testnet node.
 *
 *   POST {ARC_URL}/v1/tx          { rawTx: <EF hex> }
 *   GET  {ARC_URL}/v1/tx/{txid}   status / merkle path
 */
import { config } from './config.js'
import { hexToBytes, concat } from './bytes.js'

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

export interface ArcadeBatchResult {
  kind: 'batch'
  submitted: number
  duplicates: number
  total: number
  status?: number
  reason?: string
  txid?: string
  [k: string]: unknown
}

export type ArcBatchResult = ArcadeBatchResult | ArcSubmitResult[]

const headers = (contentType = 'application/json'): Record<string, string> => {
  const h: Record<string, string> = { 'Content-Type': contentType }
  if (config.arcApiKey) h['Authorization'] = `Bearer ${config.arcApiKey}`
  if (config.arcWaitFor) h['X-WaitFor'] = config.arcWaitFor
  if (config.arcCallbackUrl) h['X-CallbackUrl'] = config.arcCallbackUrl
  return h
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const retryAfterMs = (res: Response): number => {
  const retry = Number(res.headers.get('retry-after') ?? '1')
  return Number.isFinite(retry) ? Math.max(1, retry * 1000) : 1000
}

export const arcadeBatchBody = (hexes: string[]): Uint8Array => concat(...hexes.map(hexToBytes))

export const arcSubmit = async (efHex: string): Promise<ArcSubmitResult> => {
  if (config.arcFlavor === 'arcade') {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${config.arcUrl}/tx`, {
        method: 'POST',
        headers: headers('text/plain'),
        body: efHex,
      })
      const body = (await res.json().catch(() => ({}))) as ArcSubmitResult
      if (res.status === 503 && attempt < 2) {
        await sleep(retryAfterMs(res))
        continue
      }
      if (!res.ok) throw new ArcError(res.status, body)
      return body
    }
    throw new Error('Arcade submission retry limit exceeded')
  }
  const res = await fetch(`${config.arcUrl}/v1/tx`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ rawTx: efHex }),
  })
  const body = (await res.json().catch(() => ({}))) as ArcSubmitResult
  if (!res.ok && res.status !== 200 && res.status !== 201) throw new ArcError(res.status, body)
  return body
}

export const arcSubmitBatch = async (efHexes: string[]): Promise<ArcBatchResult> => {
  if (config.arcFlavor === 'arcade') {
    const bodyBytes = arcadeBatchBody(efHexes)
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${config.arcUrl}/txs`, {
        method: 'POST',
        headers: headers('application/octet-stream'),
        body: Buffer.from(bodyBytes),
      })
      const body = (await res.json().catch(() => ({}))) as ArcadeBatchResult
      if (res.status === 503 && attempt < 2) {
        await sleep(retryAfterMs(res))
        continue
      }
      if (!res.ok) {
        if (res.status === 404 || res.status === 405) throw new ArcBatchUnavailableError(res.status)
        throw new ArcError(res.status, body as unknown as ArcSubmitResult)
      }
      return { ...body, kind: 'batch', status: res.status }
    }
    throw new Error('Arcade batch submission retry limit exceeded')
  }
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
  const path = config.arcFlavor === 'arcade' ? `/tx/${txid}` : `/v1/tx/${txid}`
  const res = await fetch(`${config.arcUrl}${path}`, { headers: headers() })
  const body = (await res.json().catch(() => ({}))) as ArcSubmitResult
  if (!res.ok) throw new ArcError(res.status, body)
  return body
}

export class ArcError extends Error {
  constructor(public httpStatus: number, public body: ArcSubmitResult) {
    super(`ARC ${httpStatus}: ${body.title ?? ''} ${body.detail ?? body.extraInfo ?? ''}`.trim())
  }
}

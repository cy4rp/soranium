import { config } from '../config.js'
import { bytesToHex } from '../bytes.js'
import { parseTx } from '../tx.js'
import type { Utxo } from '../stas/swap.js'

export interface WalletUtxo {
  txid: string
  vout: number
  satoshis: bigint
  script: string
}

const rawCache = new Map<string, string>()

const json = async (path: string): Promise<unknown> => {
  const res = await fetch(`${config.wocUrl.replace(/\/$/, '')}${path}`)
  if (!res.ok) throw new Error(`WoC ${res.status}: ${await res.text()}`)
  return res.json()
}

export const getRawTx = async (txid: string): Promise<string> => {
  const cached = rawCache.get(txid)
  if (cached) return cached
  const body = await json(`/tx/${txid}/hex`)
  const raw = typeof body === 'string'
    ? body
    : typeof body === 'object' && body !== null && 'hex' in body
      ? String((body as { hex: unknown }).hex)
      : ''
  if (!/^[0-9a-f]+$/i.test(raw)) throw new Error(`WoC returned no raw transaction for ${txid}`)
  rawCache.set(txid, raw)
  return raw
}

export const getUtxos = async (address: string, limit?: number): Promise<WalletUtxo[]> => {
  const body = await json(`/address/${address}/unspent`)
  const rows = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && 'unspent' in body
      ? (body as { unspent: unknown[] }).unspent
      : []
  const out: WalletUtxo[] = []
  for (const row of rows.slice(0, limit ?? rows.length) as Record<string, unknown>[]) {
    const txid = String(row.tx_hash ?? row.txid ?? row.tx_hash_big_endian ?? '')
    const vout = Number(row.tx_pos ?? row.vout ?? row.tx_pos_n ?? 0)
    const satoshis = BigInt(String(row.value ?? row.satoshis ?? 0))
    const raw = await getRawTx(txid)
    const parsed = parseTx(raw)
    const output = parsed.outputs[vout]
    if (!output) throw new Error(`WoC UTXO ${txid}:${vout} is missing from raw transaction`)
    out.push({ txid, vout, satoshis, script: bytesToHex(output.script) })
  }
  return out
}

export const getBalance = async (address: string): Promise<unknown> =>
  json(`/address/${address}/balance`)

export const getChainInfo = async (): Promise<unknown> => json('/chain/info')

export const utxoWithSource = async (txid: string, vout: number): Promise<Utxo> => {
  const sourceTxHex = await getRawTx(txid)
  const parsed = parseTx(sourceTxHex)
  const output = parsed.outputs[vout]
  if (!output) throw new Error(`vout ${vout} missing in ${txid}`)
  return { txid, vout, satoshis: output.satoshis, script: bytesToHex(output.script), sourceTxHex }
}

export const clearRawTxCache = (): void => rawCache.clear()

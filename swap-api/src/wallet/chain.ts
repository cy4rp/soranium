import { config } from '../config.js'
import { bytesToHex } from '../bytes.js'
import { parseTx, serializeTx, Tx } from '../tx.js'
import type { Utxo } from '../stas/swap.js'

export interface WalletUtxo {
  txid: string
  vout: number
  satoshis: bigint
  script: string
}

const rawCache = new Map<string, string>()

class WocError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

const json = async (path: string): Promise<unknown> => {
  const res = await fetch(`${config.wocUrl.replace(/\/$/, '')}${path}`)
  if (!res.ok) throw new WocError(res.status, `WoC ${res.status}: ${await res.text()}`)
  return res.json()
}

const reconstructRawTx = (body: Record<string, unknown>, txid: string): string => {
  const vin = Array.isArray(body.vin) ? body.vin as Record<string, unknown>[] : []
  const vout = Array.isArray(body.vout) ? body.vout as Record<string, unknown>[] : []
  const tx: Tx = {
    version: Number(body.version ?? 1),
    inputs: vin.map((input) => ({
      txid: String(input.txid ?? input.tx_hash ?? ''),
      vout: Number(input.vout ?? input.tx_pos ?? 0),
      script: Uint8Array.from(Buffer.from(String((input.scriptSig as Record<string, unknown> | undefined)?.hex ?? ''), 'hex')),
      sequence: Number(input.sequence ?? 0xffffffff),
      prevSatoshis: 0n,
      prevScript: new Uint8Array(0),
    })),
    outputs: vout.map((output) => ({
      satoshis: BigInt(Math.round(Number(output.value ?? 0) * 100_000_000)),
      script: Uint8Array.from(Buffer.from(String((output.scriptPubKey as Record<string, unknown> | undefined)?.hex ?? ''), 'hex')),
    })),
    lockTime: Number(body.locktime ?? 0),
  }
  const raw = bytesToHex(serializeTx(tx))
  if (parseTx(raw).txid !== txid) throw new Error(`WoC reconstructed txid mismatch for ${txid}`)
  return raw
}

export const getRawTx = async (txid: string): Promise<string> => {
  const cached = rawCache.get(txid)
  if (cached) return cached
  let raw = ''
  try {
    const body = await json(`/tx/${txid}/hex`)
    raw = typeof body === 'string'
      ? body
      : typeof body === 'object' && body !== null && 'hex' in body
        ? String((body as { hex: unknown }).hex)
        : ''
  } catch (error) {
    if (!(error instanceof WocError) || error.status !== 404) throw error
    const body = await json(`/tx/hash/${txid}`)
    if (typeof body !== 'object' || body === null) throw new Error(`WoC returned no transaction JSON for ${txid}`)
    raw = reconstructRawTx(body as Record<string, unknown>, txid)
  }
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

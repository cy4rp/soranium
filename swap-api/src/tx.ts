/**
 * Minimal BSV transaction model: serialize, txid, BIP-239 Extended Format (for ARC),
 * and raw-byte offsets of outputs (needed to excise a locking script into swap "pieces").
 */
import { createHash } from 'node:crypto'
const sha256 = (b: Uint8Array): Uint8Array => createHash('sha256').update(b).digest()
import { Reader, bytesToHex, concat, hexToBytes, u32le, u64le, varInt } from './bytes.js'

export interface TxIn {
  /** txid in display (big-endian) hex */
  txid: string
  vout: number
  script: Uint8Array
  sequence: number
  /** prev output info — required for sighash + EF */
  prevSatoshis: bigint
  prevScript: Uint8Array
}

export interface TxOut {
  satoshis: bigint
  script: Uint8Array
}

export interface Tx {
  version: number
  inputs: TxIn[]
  outputs: TxOut[]
  lockTime: number
}

const txidBytesLE = (txid: string): Uint8Array => hexToBytes(txid).reverse()

const serializeInput = (i: TxIn): Uint8Array =>
  concat(txidBytesLE(i.txid), u32le(i.vout), varInt(i.script.length), i.script, u32le(i.sequence))

const serializeOutput = (o: TxOut): Uint8Array =>
  concat(u64le(o.satoshis), varInt(o.script.length), o.script)

export const serializeTx = (tx: Tx): Uint8Array =>
  concat(
    u32le(tx.version),
    varInt(tx.inputs.length),
    ...tx.inputs.map(serializeInput),
    varInt(tx.outputs.length),
    ...tx.outputs.map(serializeOutput),
    u32le(tx.lockTime),
  )

/** BIP-239 Extended Format — preferred ARC submission format (standalone validation). */
export const serializeTxEF = (tx: Tx): Uint8Array =>
  concat(
    u32le(tx.version),
    hexToBytes('0000000000ef'),
    varInt(tx.inputs.length),
    ...tx.inputs.map((i) =>
      concat(serializeInput(i), u64le(i.prevSatoshis), varInt(i.prevScript.length), i.prevScript),
    ),
    varInt(tx.outputs.length),
    ...tx.outputs.map(serializeOutput),
    u32le(tx.lockTime),
  )

export const sha256d = (b: Uint8Array): Uint8Array => sha256(sha256(b))

export const txidOf = (tx: Tx): string => bytesToHex(sha256d(serializeTx(tx)).reverse())

/** Parse a raw transaction, recording the byte range of each output's locking script. */
export interface ParsedTx {
  bytes: Uint8Array
  txid: string
  outputs: { satoshis: bigint; script: Uint8Array; scriptStart: number; scriptEnd: number }[]
}

export const parseTx = (raw: Uint8Array | string): ParsedTx => {
  const bytes = typeof raw === 'string' ? hexToBytes(raw) : raw
  const r = new Reader(bytes)
  r.u32() // version
  const nIn = Number(r.varInt())
  for (let i = 0; i < nIn; i++) {
    r.take(36)
    const len = Number(r.varInt())
    r.take(len)
    r.take(4)
  }
  const nOut = Number(r.varInt())
  const outputs: ParsedTx['outputs'] = []
  for (let i = 0; i < nOut; i++) {
    const satoshis = r.u64()
    const len = Number(r.varInt())
    const scriptStart = r.pos
    const script = r.take(len)
    outputs.push({ satoshis, script, scriptStart, scriptEnd: r.pos })
  }
  r.take(4) // lockTime
  if (r.pos !== bytes.length) throw new Error('trailing bytes after transaction')
  return { bytes, txid: bytesToHex(sha256d(bytes).reverse()), outputs }
}

/**
 * Swap "pieces": the byte spans of a preceding transaction that remain after
 * excising the locking script of output `vout`. The engine re-CATs these around
 * the counterparty locking script (supplied separately) and HASH256-verifies
 * the result against the spent outpoint's txid.
 */
export const txPieces = (rawPrevTx: Uint8Array | string, vout: number): Uint8Array[] => {
  const parsed = parseTx(rawPrevTx)
  const out = parsed.outputs[vout]
  if (!out) throw new Error(`vout ${vout} not found in preceding tx`)
  return [parsed.bytes.subarray(0, out.scriptStart), parsed.bytes.subarray(out.scriptEnd)]
}

/**
 * BSV (BIP143-style, FORKID) sighash preimage + ECDSA signing.
 * The same preimage bytes are pushed in STAS unlocking scripts for OP_PUSH_TX.
 */
import { PrivateKey } from '@bsv/sdk'
import { concat, u32le, u64le, varInt } from './bytes.js'
import { fastSignDigest, privBytes, sha256dFast } from './fastsign.js'
import { Tx, sha256d } from './tx.js'
import { hexToBytes } from './bytes.js'

const txidLE = (txid: string) => hexToBytes(txid).reverse()

/** hashPrevouts/hashSequence/hashOutputs are identical across all inputs of one
 *  tx (SIGHASH_ALL, no ANYONECANPAY) — cache them per tx object. */
const midstateCache = new WeakMap<Tx, { prevouts: Uint8Array; sequence: Uint8Array; outputs: Uint8Array }>()
const midstates = (tx: Tx) => {
  let m = midstateCache.get(tx)
  if (!m) {
    m = {
      prevouts: sha256d(concat(...tx.inputs.map((i) => concat(txidLE(i.txid), u32le(i.vout))))),
      sequence: sha256d(concat(...tx.inputs.map((i) => u32le(i.sequence)))),
      outputs: sha256d(concat(...tx.outputs.map((o) => concat(u64le(o.satoshis), varInt(o.script.length), o.script)))),
    }
    midstateCache.set(tx, m)
  }
  return m
}

export const sighashPreimage = (tx: Tx, inputIndex: number, sighashType: number): Uint8Array => {
  const ZERO32 = (): Uint8Array => new Uint8Array(32)
  const input = tx.inputs[inputIndex]
  const anyoneCanPay = (sighashType & 0x80) !== 0
  const base = sighashType & 0x1f // 1=ALL 2=NONE 3=SINGLE

  const m = anyoneCanPay && base !== 1 ? null : midstates(tx)
  const hashPrevouts: Uint8Array = anyoneCanPay ? ZERO32() : m!.prevouts
  const hashSequence: Uint8Array = anyoneCanPay || base !== 1 ? ZERO32() : m!.sequence

  let hashOutputs: Uint8Array = ZERO32()
  if (base === 1) {
    hashOutputs = m!.outputs
  } else if (base === 3 && inputIndex < tx.outputs.length) {
    const o = tx.outputs[inputIndex]
    hashOutputs = sha256d(concat(u64le(o.satoshis), varInt(o.script.length), o.script))
  }

  return concat(
    u32le(tx.version),
    hashPrevouts,
    hashSequence,
    txidLE(input.txid), u32le(input.vout),
    varInt(input.prevScript.length), input.prevScript,
    u64le(input.prevSatoshis),
    u32le(input.sequence),
    hashOutputs,
    u32le(tx.lockTime),
    u32le(sighashType >>> 0),
  )
}

/** DER signature with sighash byte appended — ready for an unlocking-script push. */
export const signPreimage = (preimage: Uint8Array, key: PrivateKey, sighashType: number): Uint8Array =>
  signPreimageRaw(preimage, privBytes(key), sighashType)

/** Hot-path variant taking raw 32-byte private key (no @bsv/sdk object overhead). */
export const signPreimageRaw = (preimage: Uint8Array, priv: Uint8Array, sighashType: number): Uint8Array =>
  fastSignDigest(sha256dFast(preimage), priv, sighashType)

/**
 * STAS 3.0 unlocking-script builder.
 *
 * ⚠ LAYOUT NOTE — read before production use.
 * The exact stack order consumed by the 20KB engine is defined by the official
 * template, not fully enumerated in the public prose spec. The order below follows
 * spec v0.2.1's narrative (output declarations → note → funding change → funding vout
 * → spendType → txType → txType-1 trailing params → preimage → sig → pubkey/redeem).
 * It is centralized HERE so that, after validating one spend against your own
 * testnet node (sendrawtransaction / verifyscript), any reordering is a one-file fix.
 */
import { minimalPush } from './script.js'
import { concat, u64le } from '../bytes.js'
import { SIGHASH_ALL_FORKID } from './constants.js'

/** Declaration of one token output, mirrored by the engine against the preimage. */
export interface TokenOutputDecl {
  satoshis: bigint
  owner: Uint8Array // 20 bytes
  var2: Uint8Array // decoded action data ('' for plain)
}

export interface CounterpartyParams {
  /** counterparty's full locking script (their token's current locking script) */
  lockingScript: Uint8Array
  /** pieces of the counterparty's preceding tx with that locking script excised */
  pieces: Uint8Array[]
}

export interface StasUnlockParams {
  tokenOutputs: TokenOutputDecl[]
  /** OP_FALSE OP_RETURN note payload, if any */
  note?: Uint8Array
  /** P2PKH change from the funding input; omit when no change output exists */
  change?: { satoshis: bigint; pkh: Uint8Array }
  /** input index of the funding UTXO in the spending tx */
  fundingVin: number
  spendType: number
  txType: number
  /** required when txType === 1 (swap) */
  counterparty?: CounterpartyParams
  /** full sighash preimage of THIS input */
  preimage: Uint8Array
  /** DER‖sighashByte; omit for signature-suppression (owner = HASH160("")) */
  signature?: Uint8Array
  /** 33-byte pubkey (P2PKH) or redeem buffer (P2MPKH); omit with signature */
  pubKeyOrRedeemBuffer?: Uint8Array
  /** P2MPKH unlock needs the leading OP_0 dummy + multiple sigs */
  multisigSignatures?: Uint8Array[]
}

const pushNum = (n: number): Uint8Array => {
  if (n === 0) return new Uint8Array([0x00])
  if (n >= 1 && n <= 16) return new Uint8Array([0x50 + n])
  // minimal script-number encoding for larger values
  const bytes: number[] = []
  let v = n
  while (v > 0) { bytes.push(v & 0xff); v >>= 8 }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00)
  return minimalPush(Uint8Array.from(bytes))
}

export const buildStasUnlock = (p: StasUnlockParams): Uint8Array => {
  const parts: Uint8Array[] = []

  // 1. token output declarations: <satoshis 8LE> <owner 20B> <var2>
  for (const o of p.tokenOutputs) {
    parts.push(minimalPush(u64le(o.satoshis)))
    parts.push(minimalPush(o.owner))
    parts.push(minimalPush(o.var2))
  }

  // 2. note output payload (OP_FALSE when absent)
  parts.push(p.note?.length ? minimalPush(p.note) : new Uint8Array([0x00]))

  // 3. funding change declaration (OP_FALSE when no change output)
  if (p.change) {
    parts.push(minimalPush(u64le(p.change.satoshis)))
    parts.push(minimalPush(p.change.pkh))
  } else {
    parts.push(new Uint8Array([0x00]))
  }

  // 4. funding input index
  parts.push(pushNum(p.fundingVin))

  // 5. spendType / txType
  parts.push(pushNum(p.spendType))
  parts.push(pushNum(p.txType))

  // 6. txType=1 trailing params: counterparty script, piece count, pieces
  if (p.txType === 1) {
    if (!p.counterparty) throw new Error('txType=1 requires counterparty params')
    parts.push(minimalPush(p.counterparty.lockingScript))
    parts.push(pushNum(p.counterparty.pieces.length))
    for (const piece of p.counterparty.pieces) parts.push(minimalPush(piece))
  }

  // 7. preimage
  parts.push(minimalPush(p.preimage))

  // 8. authorization: P2PKH sig+pubkey / P2MPKH OP_0 sigs… redeem / OP_FALSE OP_FALSE
  if (p.multisigSignatures?.length) {
    parts.push(new Uint8Array([0x00])) // CHECKMULTISIG dummy
    for (const s of p.multisigSignatures) parts.push(minimalPush(s))
    parts.push(minimalPush(p.pubKeyOrRedeemBuffer ?? new Uint8Array(0)))
  } else if (p.signature && p.pubKeyOrRedeemBuffer) {
    parts.push(minimalPush(p.signature))
    parts.push(minimalPush(p.pubKeyOrRedeemBuffer))
  } else {
    parts.push(new Uint8Array([0x00]), new Uint8Array([0x00])) // signature-suppression
  }

  return concat(...parts)
}

/** Conservative size estimate of the unlocking script (for fee calculation). */
export const estimateUnlockSize = (p: Omit<StasUnlockParams, 'preimage' | 'signature'> & { prevScriptLen: number }): number => {
  const preimageLen = 4 + 32 + 32 + 36 + 9 + p.prevScriptLen + 8 + 4 + 32 + 4 + 4
  const dummy: StasUnlockParams = {
    ...p,
    preimage: new Uint8Array(preimageLen),
    signature: new Uint8Array(72 + 1),
    pubKeyOrRedeemBuffer: p.pubKeyOrRedeemBuffer ?? new Uint8Array(33),
  }
  return buildStasUnlock(dummy).length
}

export const SIGHASH_STAS = SIGHASH_ALL_FORKID

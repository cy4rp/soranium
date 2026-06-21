/**
 * High-level STAS 3.0 swap transaction builders.
 * Offer = install a swap descriptor in var2; Take = txType-1 atomic swap with
 * counterparty tx reconstruction; Cancel = spendType-4 spend back to receiveAddr.
 */
import { concat, eq, hexToBytes } from '../bytes.js'
import { Tx, TxIn, serializeTx, serializeTxEF, txPieces, txidOf, parseTx } from '../tx.js'
import { sighashPreimage, signPreimageRaw } from '../sighash.js'
import { buildStasScript, minimalPush, p2pkh, parseStasScript } from './script.js'
import { SwapDescriptor, decodeSwapDescriptor, encodeSwapDescriptor, requiredWantedAmount } from './descriptor.js'
import { ACTION, EMPTY_HASH160, SPEND_TYPE, TX_TYPE } from './constants.js'
import { TokenOutputDecl, buildStasUnlock, estimateUnlockSize, SIGHASH_STAS } from './unlock.js'
import { keyMaterialFromWif } from '../keys.js'
import { bytesToHex } from '../bytes.js'

export interface Utxo {
  txid: string
  vout: number
  satoshis: bigint
  /** locking script hex */
  script: string
  /** full raw hex of the tx that created this UTXO (needed for swap pieces / EF) */
  sourceTxHex: string
}

const toTxIn = (u: Utxo): TxIn => ({
  txid: u.txid,
  vout: u.vout,
  script: new Uint8Array(0),
  sequence: 0xffffffff,
  prevSatoshis: u.satoshis,
  prevScript: hexToBytes(u.script),
})

const verifyUtxoAgainstSource = (u: Utxo): void => {
  const parsed = parseTx(u.sourceTxHex)
  if (parsed.txid !== u.txid) throw new Error(`sourceTxHex txid mismatch for ${u.txid}`)
  const out = parsed.outputs[u.vout]
  if (!out) throw new Error(`vout ${u.vout} missing in sourceTxHex of ${u.txid}`)
  if (out.satoshis !== u.satoshis) throw new Error(`satoshis mismatch for ${u.txid}:${u.vout}`)
  if (!eq(out.script, hexToBytes(u.script))) throw new Error(`script mismatch for ${u.txid}:${u.vout}`)
}

import type { KeyMaterial } from '../keys.js'

const p2pkhUnlock = (tx: Tx, vin: number, km: KeyMaterial): Uint8Array => {
  const preimage = sighashPreimage(tx, vin, SIGHASH_STAS)
  const sig = signPreimageRaw(preimage, km.priv, SIGHASH_STAS)
  return concat(minimalPush(sig), minimalPush(km.pub))
}

const feeFor = (sizeBytes: number, feePerKb: number): bigint =>
  BigInt(Math.max(1, Math.ceil((sizeBytes * feePerKb) / 1000)))

const noteOutput = (note: Uint8Array) =>
  ({ satoshis: 0n, script: concat(new Uint8Array([0x00, 0x6a]), minimalPush(note)) })

export interface BuiltTx {
  txid: string
  rawHex: string
  efHex: string
  tx: Tx
}

const finalize = (tx: Tx): BuiltTx => ({
  txid: txidOf(tx),
  rawHex: bytesToHex(serializeTx(tx)),
  efHex: bytesToHex(serializeTxEF(tx)),
  tx,
})

// ---------------------------------------------------------------------------
// 1. Create offer — spend the maker's token UTXO into a swap-configured UTXO
// ---------------------------------------------------------------------------

export interface CreateOfferParams {
  tokenUtxo: Utxo
  /** WIF of the current token owner (P2PKH) */
  ownerWif: string
  fundingUtxo: Utxo
  fundingWif: string
  /** requested asset: full locking script hex of any UTXO of the wanted token */
  requestedTokenScriptHex: string
  /** PKH/MPKH (hex, 20 bytes) that will receive the wanted asset & may cancel */
  receiveAddrHex: string
  rateNumerator: number
  rateDenominator: number
  /** literal next-var2 hex for remainders (optional, advanced) */
  nextVar2Hex?: string
  /**
   * owner field for the swap UTXO. Default EMPTY_HASH160 = permissionless take
   * (signature suppression). Set an arbitrator PKH/MPKH to require their signature.
   */
  swapOwnerHex?: string
  feePerKb: number
  noteHex?: string
}

export const buildOfferTx = (p: CreateOfferParams): { built: BuiltTx; descriptor: SwapDescriptor; swapScriptHex: string } => {
  verifyUtxoAgainstSource(p.tokenUtxo)
  verifyUtxoAgainstSource(p.fundingUtxo)

  const ownerKm = keyMaterialFromWif(p.ownerWif)
  const fundingKm = keyMaterialFromWif(p.fundingWif)
  const token = parseStasScript(p.tokenUtxo.script)
  if (!eq(token.owner, ownerKm.pkh)) throw new Error('ownerWif does not match the token UTXO owner field')
  if (token.var2[0] === ACTION.FROZEN) throw new Error('token UTXO is frozen')

  const requested = parseStasScript(p.requestedTokenScriptHex)
  const descriptor: SwapDescriptor = {
    requestedScriptHash: requested.persistentHash,
    receiveAddr: hexToBytes(p.receiveAddrHex),
    rateNumerator: p.rateNumerator,
    rateDenominator: p.rateDenominator,
    next: p.nextVar2Hex ? hexToBytes(p.nextVar2Hex) : undefined,
  }
  const var2 = encodeSwapDescriptor(descriptor)
  const swapOwner = p.swapOwnerHex ? hexToBytes(p.swapOwnerHex) : EMPTY_HASH160
  const swapScript = buildStasScript(swapOwner, var2, token.tail)

  const note = p.noteHex ? hexToBytes(p.noteHex) : undefined
  const changePkh = fundingKm.pkh
  const decl: TokenOutputDecl[] = [{ satoshis: p.tokenUtxo.satoshis, owner: swapOwner, var2 }]

  const build = (changeSats: bigint): Tx => {
    const outputs = [{ satoshis: p.tokenUtxo.satoshis, script: swapScript }]
    if (note) outputs.push(noteOutput(note))
    if (changeSats > 0n) outputs.push({ satoshis: changeSats, script: p2pkh(changePkh) })
    return { version: 2, inputs: [toTxIn(p.tokenUtxo), toTxIn(p.fundingUtxo)], outputs, lockTime: 0 }
  }

  // size estimation pass
  const unlockEst = estimateUnlockSize({
    tokenOutputs: decl, note, change: { satoshis: 0n, pkh: changePkh }, fundingVin: 1,
    spendType: SPEND_TYPE.REGULAR, txType: TX_TYPE.REGULAR, prevScriptLen: hexToBytes(p.tokenUtxo.script).length,
  })
  const skeleton = build(1n)
  const estSize = serializeTx(skeleton).length + unlockEst + 107 /* p2pkh unlock */
  const fee = feeFor(estSize, p.feePerKb)
  const changeSats = p.fundingUtxo.satoshis - fee
  if (changeSats < 0n) throw new Error(`funding UTXO too small: need ≥ ${fee} sats`)

  const tx = build(changeSats)
  const change = changeSats > 0n ? { satoshis: changeSats, pkh: changePkh } : undefined

  const preimage = sighashPreimage(tx, 0, SIGHASH_STAS)
  tx.inputs[0].script = buildStasUnlock({
    tokenOutputs: decl, note, change, fundingVin: 1,
    spendType: SPEND_TYPE.REGULAR, txType: TX_TYPE.REGULAR,
    preimage,
    signature: signPreimageRaw(preimage, ownerKm.priv, SIGHASH_STAS),
    pubKeyOrRedeemBuffer: ownerKm.pub,
  })
  tx.inputs[1].script = p2pkhUnlock(tx, 1, fundingKm)

  return { built: finalize(tx), descriptor, swapScriptHex: bytesToHex(swapScript) }
}

// ---------------------------------------------------------------------------
// 2. Take offer — atomic swap (txType=1), full or partial, both legs may split
// ---------------------------------------------------------------------------

export interface TakeOfferParams {
  makerUtxo: Utxo // swap-configured offer UTXO (input #0)
  takerUtxo: Utxo // taker's UTXO of the requested asset (input #1)
  takerWif: string
  fundingUtxo: Utxo
  fundingWif: string
  /** offered-asset units (token satoshis) to take; defaults to the full offer */
  takeAmount?: bigint
  /** wanted-asset units delivered to maker; defaults to the rate-required minimum */
  wantedAmount?: bigint
  /** taker's receiving PKH for the offered asset; defaults to takerWif's PKH */
  takerReceivePkhHex?: string
  feePerKb: number
  noteHex?: string
}

export const buildTakeTx = (p: TakeOfferParams): { built: BuiltTx; makerRemainder: bigint; takerRemainder: bigint; remainderVout?: number } => {
  verifyUtxoAgainstSource(p.makerUtxo)
  verifyUtxoAgainstSource(p.takerUtxo)
  verifyUtxoAgainstSource(p.fundingUtxo)

  const takerKm = keyMaterialFromWif(p.takerWif)
  const fundingKm = keyMaterialFromWif(p.fundingWif)

  const maker = parseStasScript(p.makerUtxo.script)
  const taker = parseStasScript(p.takerUtxo.script)
  const descriptor = decodeSwapDescriptor(maker.var2)

  if (!eq(taker.persistentHash, descriptor.requestedScriptHash))
    throw new Error('takerUtxo is not the requested asset (script-tail hash mismatch)')
  if (!eq(taker.owner, takerKm.pkh)) throw new Error('takerWif does not match takerUtxo owner field')
  if (!eq(maker.owner, EMPTY_HASH160))
    throw new Error('offer requires an arbitrator signature (owner ≠ EMPTY_HASH160) — not supported by this endpoint')
  if (taker.var2[0] === ACTION.FROZEN || maker.var2[0] === ACTION.FROZEN) throw new Error('frozen UTXO in swap')

  const takeAmount = p.takeAmount ?? p.makerUtxo.satoshis
  if (takeAmount <= 0n || takeAmount > p.makerUtxo.satoshis) throw new Error('takeAmount out of range')
  const required = requiredWantedAmount(takeAmount, descriptor.rateNumerator, descriptor.rateDenominator)
  const wanted = p.wantedAmount ?? required
  if (wanted < required) throw new Error(`wantedAmount ${wanted} below rate-required minimum ${required}`)
  if (wanted > p.takerUtxo.satoshis) throw new Error('takerUtxo does not cover the required wanted amount')

  const makerRemainder = p.makerUtxo.satoshis - takeAmount
  const takerRemainder = p.takerUtxo.satoshis - wanted
  const takerPkh = p.takerReceivePkhHex ? hexToBytes(p.takerReceivePkhHex) : takerKm.pkh
  const plain = new Uint8Array(0)
  // Remainder var2: spec — remainder inherits the source var2 (offer stays takeable),
  // unless the descriptor carries an explicit `next` value to install.
  const remainderVar2 = descriptor.next ?? maker.var2

  // Outputs — spec assignment: requested asset at the initiator's input index (0 → maker),
  // given asset at the counterparty index (1 → taker), then optional remainders.
  type Leg = { satoshis: bigint; owner: Uint8Array; var2: Uint8Array; tail: Uint8Array }
  const legs: Leg[] = [
    { satoshis: wanted, owner: descriptor.receiveAddr, var2: plain, tail: taker.tail }, // out0: wanted → maker
    { satoshis: takeAmount, owner: takerPkh, var2: plain, tail: maker.tail },           // out1: offered → taker
  ]
  let remainderVout: number | undefined
  if (makerRemainder > 0n) {
    remainderVout = legs.length
    legs.push({ satoshis: makerRemainder, owner: maker.owner, var2: remainderVar2, tail: maker.tail })
  }
  if (takerRemainder > 0n) legs.push({ satoshis: takerRemainder, owner: taker.owner, var2: taker.var2, tail: taker.tail })

  const decl: TokenOutputDecl[] = legs.map((l) => ({ satoshis: l.satoshis, owner: l.owner, var2: l.var2 }))
  const note = p.noteHex ? hexToBytes(p.noteHex) : undefined
  const changePkh = fundingKm.pkh
  const fundingVin = 2

  const build = (changeSats: bigint): Tx => {
    const outputs = legs.map((l) => ({ satoshis: l.satoshis, script: buildStasScript(l.owner, l.var2, l.tail) }))
    if (note) outputs.push(noteOutput(note))
    if (changeSats > 0n) outputs.push({ satoshis: changeSats, script: p2pkh(changePkh) })
    return {
      version: 2,
      inputs: [toTxIn(p.makerUtxo), toTxIn(p.takerUtxo), toTxIn(p.fundingUtxo)],
      outputs,
      lockTime: 0,
    }
  }

  // counterparty reconstruction material for each token input
  const makerPieces = txPieces(p.makerUtxo.sourceTxHex, p.makerUtxo.vout)
  const takerPieces = txPieces(p.takerUtxo.sourceTxHex, p.takerUtxo.vout)
  const makerScriptBytes = hexToBytes(p.makerUtxo.script)
  const takerScriptBytes = hexToBytes(p.takerUtxo.script)

  const unlockCommon = { tokenOutputs: decl, note, fundingVin, spendType: SPEND_TYPE.REGULAR, txType: TX_TYPE.SWAP }
  const est0 = estimateUnlockSize({ ...unlockCommon, change: { satoshis: 0n, pkh: changePkh }, counterparty: { lockingScript: takerScriptBytes, pieces: takerPieces }, prevScriptLen: makerScriptBytes.length })
  const est1 = estimateUnlockSize({ ...unlockCommon, change: { satoshis: 0n, pkh: changePkh }, counterparty: { lockingScript: makerScriptBytes, pieces: makerPieces }, prevScriptLen: takerScriptBytes.length })
  const estSize = serializeTx(build(1n)).length + est0 + est1 + 107
  const fee = feeFor(estSize, p.feePerKb)
  const changeSats = p.fundingUtxo.satoshis - fee
  if (changeSats < 0n) throw new Error(`funding UTXO too small: need ≥ ${fee} sats`)

  const tx = build(changeSats)
  const change = changeSats > 0n ? { satoshis: changeSats, pkh: changePkh } : undefined

  // input #0 — maker swap UTXO, signature-suppressed (owner = EMPTY_HASH160)
  tx.inputs[0].script = buildStasUnlock({
    ...unlockCommon, change,
    counterparty: { lockingScript: takerScriptBytes, pieces: takerPieces },
    preimage: sighashPreimage(tx, 0, SIGHASH_STAS),
  })
  // input #1 — taker token, signed by taker
  const pre1 = sighashPreimage(tx, 1, SIGHASH_STAS)
  tx.inputs[1].script = buildStasUnlock({
    ...unlockCommon, change,
    counterparty: { lockingScript: makerScriptBytes, pieces: makerPieces },
    preimage: pre1,
    signature: signPreimageRaw(pre1, takerKm.priv, SIGHASH_STAS),
    pubKeyOrRedeemBuffer: takerKm.pub,
  })
  tx.inputs[2].script = p2pkhUnlock(tx, 2, fundingKm)

  return { built: finalize(tx), makerRemainder, takerRemainder, remainderVout }
}

// ---------------------------------------------------------------------------
// 3. Cancel offer — spendType 4, single output back to receiveAddr
// ---------------------------------------------------------------------------

export interface CancelOfferParams {
  makerUtxo: Utxo
  /** WIF matching the descriptor's receiveAddr (P2PKH) */
  receiveWif: string
  fundingUtxo: Utxo
  fundingWif: string
  feePerKb: number
}

export const buildCancelTx = (p: CancelOfferParams): { built: BuiltTx } => {
  verifyUtxoAgainstSource(p.makerUtxo)
  verifyUtxoAgainstSource(p.fundingUtxo)

  const receiveKm = keyMaterialFromWif(p.receiveWif)
  const fundingKm = keyMaterialFromWif(p.fundingWif)
  const maker = parseStasScript(p.makerUtxo.script)
  const descriptor = decodeSwapDescriptor(maker.var2)
  if (!eq(descriptor.receiveAddr, receiveKm.pkh))
    throw new Error('receiveWif does not match the descriptor receiveAddr')

  const plain = new Uint8Array(0)
  const outScript = buildStasScript(descriptor.receiveAddr, plain, maker.tail)
  const decl: TokenOutputDecl[] = [{ satoshis: p.makerUtxo.satoshis, owner: descriptor.receiveAddr, var2: plain }]
  const changePkh = fundingKm.pkh

  const build = (changeSats: bigint): Tx => {
    const outputs = [{ satoshis: p.makerUtxo.satoshis, script: outScript }]
    if (changeSats > 0n) outputs.push({ satoshis: changeSats, script: p2pkh(changePkh) })
    return { version: 2, inputs: [toTxIn(p.makerUtxo), toTxIn(p.fundingUtxo)], outputs, lockTime: 0 }
  }

  const unlockEst = estimateUnlockSize({
    tokenOutputs: decl, change: { satoshis: 0n, pkh: changePkh }, fundingVin: 1,
    spendType: SPEND_TYPE.CANCEL_SWAP, txType: TX_TYPE.REGULAR, prevScriptLen: hexToBytes(p.makerUtxo.script).length,
  })
  const fee = feeFor(serializeTx(build(1n)).length + unlockEst + 107, p.feePerKb)
  const changeSats = p.fundingUtxo.satoshis - fee
  if (changeSats < 0n) throw new Error(`funding UTXO too small: need ≥ ${fee} sats`)

  const tx = build(changeSats)
  const change = changeSats > 0n ? { satoshis: changeSats, pkh: changePkh } : undefined
  const preimage = sighashPreimage(tx, 0, SIGHASH_STAS)
  tx.inputs[0].script = buildStasUnlock({
    tokenOutputs: decl, change, fundingVin: 1,
    spendType: SPEND_TYPE.CANCEL_SWAP, txType: TX_TYPE.REGULAR,
    preimage,
    signature: signPreimageRaw(preimage, receiveKm.priv, SIGHASH_STAS),
    pubKeyOrRedeemBuffer: receiveKm.pub,
  })
  tx.inputs[1].script = p2pkhUnlock(tx, 1, fundingKm)

  return { built: finalize(tx) }
}

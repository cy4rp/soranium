import { PrivateKey } from '@bsv/sdk'
import { bytesToHex, concat, hexToBytes } from '../bytes.js'
import { keyMaterialFromWif } from '../keys.js'
import { serializeTx, Tx, txidOf } from '../tx.js'
import { buildStasScript, p2pkh, parseStasScript } from '../stas/script.js'
import { SPEND_TYPE, TX_TYPE } from '../stas/constants.js'
import { buildStasUnlock, estimateUnlockSize, TokenOutputDecl, SIGHASH_STAS } from '../stas/unlock.js'
import { BuiltTx, feeFor, finalize, p2pkhUnlock, toTxIn, Utxo } from '../stas/swap.js'
import { makeTail } from '../bench/fixtures.js'
import { compileStasTemplate } from '../stas/template.js'
import { sighashPreimage, signPreimageRaw } from '../sighash.js'

type Pkh = Uint8Array | string
const pkhBytes = (pkh: Pkh): Uint8Array => typeof pkh === 'string' ? hexToBytes(pkh) : pkh

export interface P2pkhOutput { pkh: Pkh; satoshis: bigint }

export interface P2pkhSendParams {
  utxos: Utxo[]
  wif: string
  outputs: P2pkhOutput[]
  changePkh: Pkh
  feePerKb: number
}

const buildP2pkhSkeleton = (utxos: Utxo[], outputs: P2pkhOutput[], changePkh: Uint8Array, change: bigint): Tx => ({
  version: 2,
  inputs: utxos.map(toTxIn),
  outputs: [
    ...outputs.map((o) => ({ satoshis: o.satoshis, script: p2pkh(pkhBytes(o.pkh)) })),
    ...(change > 0n ? [{ satoshis: change, script: p2pkh(changePkh) }] : []),
  ],
  lockTime: 0,
})

export const buildP2pkhSend = (p: P2pkhSendParams): BuiltTx => {
  if (!p.utxos.length) throw new Error('at least one input UTXO is required')
  const totalIn = p.utxos.reduce((s, u) => s + u.satoshis, 0n)
  const totalOut = p.outputs.reduce((s, o) => s + o.satoshis, 0n)
  const changePkh = pkhBytes(p.changePkh)
  const estimate = buildP2pkhSkeleton(p.utxos, p.outputs, changePkh, 1n)
  const fee = feeFor(serializeTx(estimate).length + p.utxos.length * 107, p.feePerKb)
  const change = totalIn - totalOut - fee
  if (change < 0n) throw new Error(`inputs too small: need ≥ ${totalOut + fee} sats`)
  const tx = buildP2pkhSkeleton(p.utxos, p.outputs, changePkh, change)
  const km = keyMaterialFromWif(p.wif)
  tx.inputs.forEach((_, index) => { tx.inputs[index].script = p2pkhUnlock(tx, index, km) })
  return finalize(tx)
}

export interface SplitTxParams {
  utxo: Utxo
  wif: string
  count: number
  satoshisEach: bigint
  feePerKb: number
}

export const buildSplitTx = (p: SplitTxParams): BuiltTx => {
  if (!Number.isInteger(p.count) || p.count <= 0) throw new Error('count must be positive')
  const km = keyMaterialFromWif(p.wif)
  return buildP2pkhSend({
    utxos: [p.utxo],
    wif: p.wif,
    outputs: Array.from({ length: p.count }, () => ({ pkh: km.pkh, satoshis: p.satoshisEach })),
    changePkh: km.pkh,
    feePerKb: p.feePerKb,
  })
}

export interface StasTransferParams {
  tokenUtxo: Utxo
  ownerWif: string
  fundingUtxo: Utxo
  fundingWif: string
  toPkh: Pkh
  amount?: bigint
  feePerKb: number
  noteHex?: string
}

const noteOutput = (note: Uint8Array) =>
  ({ satoshis: 0n, script: concat(new Uint8Array([0x00, 0x6a]), new Uint8Array([note.length]), note) })

export const buildStasTransferTx = (p: StasTransferParams): BuiltTx => {
  const ownerKm = keyMaterialFromWif(p.ownerWif)
  const fundingKm = keyMaterialFromWif(p.fundingWif)
  const token = parseStasScript(p.tokenUtxo.script)
  if (!Buffer.from(token.owner).equals(Buffer.from(ownerKm.pkh))) throw new Error('ownerWif does not match token owner')
  const amount = p.amount ?? p.tokenUtxo.satoshis
  if (amount <= 0n || amount > p.tokenUtxo.satoshis) throw new Error('amount out of range')
  const remainder = p.tokenUtxo.satoshis - amount
  const toPkh = pkhBytes(p.toPkh)
  const plain = new Uint8Array(0)
  const legs = [{ satoshis: amount, owner: toPkh, var2: plain, tail: token.tail }]
  if (remainder > 0n) legs.push({ satoshis: remainder, owner: ownerKm.pkh, var2: plain, tail: token.tail })
  const decl: TokenOutputDecl[] = legs.map((l) => ({ satoshis: l.satoshis, owner: l.owner, var2: l.var2 }))
  const note = p.noteHex ? hexToBytes(p.noteHex) : undefined
  const changePkh = fundingKm.pkh
  const build = (change: bigint): Tx => ({
    version: 2,
    inputs: [toTxIn(p.tokenUtxo), toTxIn(p.fundingUtxo)],
    outputs: [
      ...legs.map((l) => ({ satoshis: l.satoshis, script: buildStasScript(l.owner, l.var2, l.tail) })),
      ...(note ? [noteOutput(note)] : []),
      ...(change > 0n ? [{ satoshis: change, script: p2pkh(changePkh) }] : []),
    ],
    lockTime: 0,
  })
  const unlockEst = estimateUnlockSize({
    tokenOutputs: decl, note, change: { satoshis: 0n, pkh: changePkh }, fundingVin: 1,
    spendType: SPEND_TYPE.REGULAR, txType: TX_TYPE.REGULAR, prevScriptLen: hexToBytes(p.tokenUtxo.script).length,
  })
  const fee = feeFor(serializeTx(build(1n)).length + unlockEst + 107, p.feePerKb)
  const change = p.fundingUtxo.satoshis - fee
  if (change < 0n) throw new Error(`funding UTXO too small: need ≥ ${fee} sats`)
  const tx = build(change)
  const unlockChange = change > 0n ? { satoshis: change, pkh: changePkh } : undefined
  const preimage = sighashPreimage(tx, 0, SIGHASH_STAS)
  tx.inputs[0].script = buildStasUnlock({
    tokenOutputs: decl, note, change: unlockChange, fundingVin: 1,
    spendType: SPEND_TYPE.REGULAR, txType: TX_TYPE.REGULAR, preimage,
    signature: signPreimageRaw(preimage, ownerKm.priv, SIGHASH_STAS), pubKeyOrRedeemBuffer: ownerKm.pub,
  })
  tx.inputs[1].script = p2pkhUnlock(tx, 1, fundingKm)
  return finalize(tx)
}

export interface StasIssueParams {
  fundingUtxo: Utxo
  wif: string
  toPkh: Pkh
  amount: bigint
  tailBytes?: number
  protoSeed?: number
  engine?: 'synthetic' | 'template'
}

export const buildStasIssueTx = (p: StasIssueParams): BuiltTx => {
  if (p.amount <= 0n) throw new Error('amount must be positive')
  const km = keyMaterialFromWif(p.wif)
  const owner = pkhBytes(p.toPkh)
  const tail = p.engine === 'template'
    ? compileStasTemplate(owner, new Uint8Array(0))
    : makeTail(p.tailBytes ?? 96, p.protoSeed ?? 1)
  const tokenScript = p.engine === 'template' ? tail : buildStasScript(owner, new Uint8Array(0), tail)
  const build = (change: bigint): Tx => ({
    version: 2,
    inputs: [toTxIn(p.fundingUtxo)],
    outputs: [
      { satoshis: p.amount, script: tokenScript },
      ...(change > 0n ? [{ satoshis: change, script: p2pkh(km.pkh) }] : []),
    ],
    lockTime: 0,
  })
  const fee = feeFor(serializeTx(build(1n)).length + 107, 50)
  const change = p.fundingUtxo.satoshis - p.amount - fee
  if (change < 0n) throw new Error(`funding UTXO too small: need ≥ ${p.amount + fee} sats`)
  const tx = build(change)
  tx.inputs[0].script = p2pkhUnlock(tx, 0, km)
  return finalize(tx)
}

export const addressForWif = (wif: string): string => {
  const key = PrivateKey.fromWif(wif)
  return key.toAddress('testnet').toString()
}

export const txidOfBuilt = (built: BuiltTx): string => txidOf(built.tx)

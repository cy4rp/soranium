import { PrivateKey } from '@bsv/sdk'
import { bytesToHex, hexToBytes } from '../bytes.js'
import { keyMaterialFromWif } from '../keys.js'
import { serializeTx, Tx } from '../tx.js'
import { p2pkh } from '../stas/script.js'
import { BuiltTx, feeFor, finalize, p2pkhUnlock, toTxIn, Utxo } from '../stas/swap.js'

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
  utxos: Utxo[]
  wif: string
  count: number
  satoshisEach: bigint
  feePerKb: number
}

export const buildSplitTx = (p: SplitTxParams): BuiltTx => {
  if (!Number.isInteger(p.count) || p.count <= 0) throw new Error('count must be positive')
  if (!p.utxos.length) throw new Error('at least one input UTXO is required')
  const km = keyMaterialFromWif(p.wif)
  return buildP2pkhSend({
    utxos: p.utxos,
    wif: p.wif,
    outputs: Array.from({ length: p.count }, () => ({ pkh: km.pkh, satoshis: p.satoshisEach })),
    changePkh: km.pkh,
    feePerKb: p.feePerKb,
  })
}

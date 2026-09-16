import * as bsv from 'dxs-bsv-token-sdk/bsv'
import * as dstas from 'dxs-bsv-token-sdk/dstas'
import { bytesToHex, hexToBytes } from '../bytes.js'
import { addressToPkh, keyMaterialFromWif } from '../keys.js'
import { serializeTxEF, parseTx, parseTxModel, txidOf } from '../tx.js'
import type { Tx } from '../tx.js'
import type { Utxo } from '../stas/swap.js'

export interface DstasBuilt {
  txid: string
  rawHex: string
  efHex: string
  tx: Tx
  spentInputs: { txid: string; vout: number }[]
  /** The P2PKH contract transaction must be broadcast before rawHex. */
  contractTxid?: string
  contractRawHex?: string
  contractEfHex?: string
  contractTx?: Tx
}

const sdk = bsv as typeof bsv & { default?: typeof bsv }
const sdkDstas = dstas as typeof dstas & { default?: typeof dstas }
const Bsv = sdk.default ?? sdk
const Dstas = sdkDstas.default ?? sdkDstas

/** The SDK's locking-script engine is kept behind this seam for future revisions. */
export const DSTAS_SDK_ENGINE = 'dxs-bsv-token-sdk@1.0.4 + Template STAS 3.1 patch'
/** STAS 3.0 spec v0.2.4 / engine Template STAS 3.1 (revision 0.0.11). */
export const DSTAS_ENGINE_REVISION = '0.0.11'
export const DSTAS_ENGINE_BASE_SIZE = 3189
/** Keeps an issue transaction well below Arcade/Cloudflare request limits. */
export const DSTAS_MAX_DESTINATIONS_PER_TX = 2000

const feeRate = (feePerKb = 1): number => Math.max(0.001, feePerKb / 1000)

const sdkKey = (wif: string): InstanceType<typeof Bsv.PrivateKey> =>
  new Bsv.PrivateKey(keyMaterialFromWif(wif).priv)

const sdkAddress = (pkh: Uint8Array | string): InstanceType<typeof Bsv.Address> =>
  Bsv.Address.fromHash160Hex(typeof pkh === 'string' ? bytesToHex(addressToPkh(pkh)) : bytesToHex(pkh))

const sdkOutPoint = (utxo: Utxo): InstanceType<typeof Bsv.OutPoint> => {
  if (!utxo.sourceTxHex) throw new Error(`source transaction is required for ${utxo.txid}:${utxo.vout}`)
  const out = Bsv.OutPoint.fromHex(utxo.sourceTxHex, utxo.vout)
  if (out.TxId !== utxo.txid || out.Satoshis !== Number(utxo.satoshis)) {
    throw new Error(`UTXO source mismatch for ${utxo.txid}:${utxo.vout}`)
  }
  return out
}

const txWithPrevouts = (rawHex: string, prevouts: Utxo[]): Tx => {
  const tx = parseTxModel(rawHex)
  const byKey = new Map(prevouts.map((u) => [`${u.txid}:${u.vout}`, u]))
  for (const input of tx.inputs) {
    const prev = byKey.get(`${input.txid}:${input.vout}`)
    if (!prev) throw new Error(`missing prevout for ${input.txid}:${input.vout}`)
    input.prevSatoshis = prev.satoshis
    input.prevScript = hexToBytes(prev.script)
  }
  return tx
}

const builtFrom = (rawHex: string, prevouts: Utxo[], spentInputs: Utxo[]): DstasBuilt => {
  const tx = txWithPrevouts(rawHex, prevouts)
  return {
    txid: txidOf(tx),
    rawHex,
    efHex: bytesToHex(serializeTxEF(tx)),
    tx,
    spentInputs: spentInputs.map(({ txid, vout }) => ({ txid, vout })),
  }
}

export interface DstasIssueParams {
  fundingUtxos: Utxo[]
  wif: string
  count: number
  satoshisEach: bigint
  tokenName?: string
  feePerKb?: number
}

export const buildDstasIssue = (p: DstasIssueParams): DstasBuilt => {
  if (!Number.isInteger(p.count) || p.count < 1 || p.count > DSTAS_MAX_DESTINATIONS_PER_TX) {
    throw new Error(`count must be between 1 and ${DSTAS_MAX_DESTINATIONS_PER_TX} per DSTAS issue transaction`)
  }
  if (p.satoshisEach <= 0n || p.satoshisEach > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('satoshisEach must be a positive safe integer')
  if (p.fundingUtxos.length !== 1) {
    throw new Error('the DSTAS SDK issue builder requires exactly one funding UTXO; consolidate funding first')
  }
  const funding = p.fundingUtxos[0]
  const key = sdkKey(p.wif)
  const issuerPkh = key.Address.Hash160
  const pubkey = Bsv.toHex(key.PublicKey)
  const name = p.tokenName ?? 'DSTAS'
  const scheme = new Bsv.TokenScheme(
    name,
    Bsv.toHex(issuerPkh),
    name,
    1,
    {
      isDivisible: true,
      freeze: true,
      confiscation: true,
      freezeAuthority: { m: 1, publicKeys: [pubkey] },
      confiscationAuthority: { m: 1, publicKeys: [pubkey] },
    },
  )
  const destinations = Array.from({ length: p.count }, () => ({
    Satoshis: Number(p.satoshisEach),
    To: key.Address,
  }))
  const result = Dstas.BuildDstasIssueTxs({
    fundingPayment: { OutPoint: sdkOutPoint(funding), Owner: key },
    scheme,
    destinations,
    feeRate: feeRate(p.feePerKb),
  })
  const contractTx = txWithPrevouts(result.contractTxHex, [funding])
  const contractParsed = parseTx(result.contractTxHex)
  const contractOutputs = contractParsed.outputs.map((output, vout) => ({
    txid: contractParsed.txid,
    vout,
    satoshis: output.satoshis,
    script: bytesToHex(output.script),
    sourceTxHex: result.contractTxHex,
  }))
  return {
    ...builtFrom(result.issueTxHex, contractOutputs, []),
    spentInputs: [{ txid: funding.txid, vout: funding.vout }],
    contractTxid: contractParsed.txid,
    contractRawHex: result.contractTxHex,
    contractEfHex: bytesToHex(serializeTxEF(contractTx)),
    contractTx,
  }
}

export interface DstasTransferParams {
  stasUtxo: Utxo
  feeUtxo: Utxo
  wif: string
  to: string | Uint8Array
  feePerKb?: number
}

export const buildDstasTransfer = (p: DstasTransferParams): DstasBuilt => {
  const key = sdkKey(p.wif)
  const destination = sdkAddress(p.to)
  const tokenReader = Bsv.LockingScriptReader.read(hexToBytes(p.stasUtxo.script))
  const token = tokenReader.Dstas
  if (!token) throw new Error(`not a DSTAS UTXO: ${p.stasUtxo.txid}:${p.stasUtxo.vout}`)
  const pubkey = Bsv.toHex(key.PublicKey)
  const scheme = new Bsv.TokenScheme(
    'DSTAS',
    Bsv.toHex(token.Redemption),
    'DSTAS',
    1,
    {
      isDivisible: true,
      freeze: token.FreezeEnabled,
      confiscation: token.ConfiscationEnabled,
      freezeAuthority: token.FreezeEnabled ? { m: 1, publicKeys: [pubkey] } : undefined,
      confiscationAuthority: token.ConfiscationEnabled ? { m: 1, publicKeys: [pubkey] } : undefined,
    },
  )
  const rawHex = Dstas.BuildDstasTransferTx({
    stasPayment: { OutPoint: sdkOutPoint(p.stasUtxo), Owner: key },
    feePayment: { OutPoint: sdkOutPoint(p.feeUtxo), Owner: key },
    destination: { Satoshis: Number(p.stasUtxo.satoshis), To: destination },
    scheme,
    feeRate: feeRate(p.feePerKb),
  })
  return builtFrom(rawHex, [p.stasUtxo, p.feeUtxo], [p.stasUtxo, p.feeUtxo])
}

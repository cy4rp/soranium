/**
 * Benchmark fixtures: synthesize independent (offer, taker, funding) triples
 * owned by the loaded WIF. Each swap in the benchmark consumes its own offer
 * UTXO — swaps are fully independent, which is the parallelism model that a
 * real L1 order book provides (one remainder chain per offer is sequential,
 * but distinct offers execute concurrently).
 */
import { PrivateKey } from '@bsv/sdk'
import { bytesToHex, concat } from '../bytes.js'
import { serializeTx, parseTx } from '../tx.js'
import { buildStasScript, p2pkh } from '../stas/script.js'
import { encodeSwapDescriptor } from '../stas/descriptor.js'
import { EMPTY_HASH160 } from '../stas/constants.js'
import { parseStasScript } from '../stas/script.js'
import { pkhOfKey } from '../keys.js'
import type { Utxo } from '../stas/swap.js'

export interface TokenInfo {
  id: string
  symbol: string
  protoId: string
  scriptHex: string
  tailBytes: number
  balance: string
}

/** Synthetic engine tail of a given size with an OP_RETURN <protoID> <flags> trailer. */
export const makeTail = (size: number, protoSeed: number): Uint8Array => {
  const engineLen = Math.max(8, size - 23)
  const engine = new Uint8Array(engineLen).fill(0x61) // OP_NOP filler
  const protoId = new Uint8Array(20)
  for (let i = 0; i < 20; i++) protoId[i] = (protoSeed * 31 + i * 7) & 0xff
  return concat(engine, new Uint8Array([0x6a, 0x14]), protoId, new Uint8Array([0x00]))
}

/** Deterministic demo token set "owned" by the WIF (regtest-style fixtures). */
export const tokensForWif = (wif: string, tailBytes: number): TokenInfo[] => {
  const key = PrivateKey.fromWif(wif)
  const owner = pkhOfKey(key)
  const defs = [
    { symbol: 'JPYC-S3', seed: 1, balance: '120000000' },
    { symbol: 'USDQ-S3', seed: 2, balance: '5400000' },
    { symbol: 'GOLD-S3', seed: 3, balance: '930000' },
  ]
  return defs.map((d) => {
    const tail = makeTail(tailBytes, d.seed)
    const script = buildStasScript(owner, new Uint8Array(0), tail)
    const parsed = parseStasScript(bytesToHex(script))
    return {
      id: `tok-${d.seed}`,
      symbol: d.symbol,
      protoId: parsed.protoId ? bytesToHex(parsed.protoId) : '',
      scriptHex: bytesToHex(script),
      tailBytes: tail.length,
      balance: d.balance,
    }
  })
}

let fakeTxNonce = 0
const fakeSourceTxHex = (script: Uint8Array, satoshis: bigint): string => {
  const nonce = (fakeTxNonce++ >>> 0)
  const prevTxid = nonce.toString(16).padStart(8, '0').repeat(8)
  return bytesToHex(serializeTx({
    version: 2,
    inputs: [{ txid: prevTxid, vout: 0, script: new Uint8Array([0x51]), sequence: 0xffffffff, prevSatoshis: 0n, prevScript: new Uint8Array(0) }],
    outputs: [{ satoshis, script }],
    lockTime: 0,
  }))
}

const utxoFrom = (sourceTxHex: string): Utxo => {
  const p = parseTx(sourceTxHex)
  return { txid: p.txid, vout: 0, satoshis: p.outputs[0].satoshis, script: bytesToHex(p.outputs[0].script), sourceTxHex }
}

export interface SwapFixture {
  makerUtxo: Utxo
  takerUtxo: Utxo
  fundingUtxo: Utxo
}

export interface FixtureSetParams {
  wif: string
  /** offered token (selected from tokensForWif) */
  offeredTokenSeed: number
  /** wanted token */
  wantedTokenSeed: number
  tailBytes: number
  count: number
  rateNumerator: number
  rateDenominator: number
}

/** Generate `count` independent offer/taker/funding triples for the benchmark. */
export const generateFixtures = (p: FixtureSetParams): SwapFixture[] => {
  const key = PrivateKey.fromWif(p.wif)
  const owner = pkhOfKey(key)
  const offeredTail = makeTail(p.tailBytes, p.offeredTokenSeed)
  const wantedTail = makeTail(p.tailBytes, p.wantedTokenSeed)
  const wantedScript = buildStasScript(owner, new Uint8Array(0), wantedTail)
  const wantedHash = parseStasScript(bytesToHex(wantedScript)).persistentHash

  const descriptor = encodeSwapDescriptor({
    requestedScriptHash: wantedHash,
    receiveAddr: owner,
    rateNumerator: p.rateNumerator,
    rateDenominator: p.rateDenominator,
  })
  const offerScript = buildStasScript(EMPTY_HASH160, descriptor, offeredTail)
  const fundingScript = p2pkh(owner)

  const out: SwapFixture[] = []
  for (let i = 0; i < p.count; i++) {
    out.push({
      makerUtxo: utxoFrom(fakeSourceTxHex(offerScript, 1_000n)),
      takerUtxo: utxoFrom(fakeSourceTxHex(wantedScript, 1_000_000n)),
      fundingUtxo: utxoFrom(fakeSourceTxHex(fundingScript, 100_000n)),
    })
  }
  return out
}

/**
 * Offline self-test: exercises offer → take (partial) → cancel builders
 * against a synthetic STAS-shaped script, and checks the structural invariants
 * (descriptor round-trip, piece reconstruction, satoshi conservation, EF format).
 * Run: npm test
 */
import { PrivateKey } from '@bsv/sdk'
import assert from 'node:assert'
import { bytesToHex, concat, eq, hexToBytes } from './bytes.js'
import { parseTx, txPieces, serializeTx, serializeTxEF, efToRaw } from './tx.js'
import { buildStasScript, p2pkh, parseStasScript } from './stas/script.js'
import { encodeSwapDescriptor, decodeSwapDescriptor, requiredWantedAmount } from './stas/descriptor.js'
import { buildOfferTx, buildTakeTx, buildCancelTx, Utxo } from './stas/swap.js'
import { EMPTY_HASH160 } from './stas/constants.js'
import { pkhOfKey } from './keys.js'
import { buildP2pkhSend, buildSplitTx, buildStasIssueTx, buildStasTransferTx } from './wallet/transfer.js'
import { runSendBench } from './wallet/sendbench.js'
import { arcadeBatchBody } from './arc.js'
import { importTx, listUtxos, markSpent, removeTx } from './wallet/store.js'
import { config } from './config.js'

// --- synthetic fixtures ------------------------------------------------------
const makerKey = PrivateKey.fromRandom()
const takerKey = PrivateKey.fromRandom()
const fundKey = PrivateKey.fromRandom()

/** A minimal stand-in tail: OP_NOP engine stub + OP_RETURN protoID + flags. */
const makeTail = (protoIdByte: number): Uint8Array =>
  concat(
    new Uint8Array(64).fill(0x61), // engine stub (OP_NOP × 64)
    new Uint8Array([0x6a, 0x14]), new Uint8Array(20).fill(protoIdByte), // OP_RETURN <protoID>
    new Uint8Array([0x00]), // flags
  )

const tailA = makeTail(0xaa) // offered token A
const tailB = makeTail(0xbb) // wanted token B

const fakeSourceTx = (script: Uint8Array, satoshis: bigint) => {
  const tx = {
    version: 2,
    inputs: [{ txid: '11'.repeat(32), vout: 0, script: new Uint8Array([0x51]), sequence: 0xffffffff, prevSatoshis: 0n, prevScript: new Uint8Array(0) }],
    outputs: [{ satoshis, script }],
    lockTime: 0,
  }
  return bytesToHex(serializeTx(tx))
}

const utxoFromSource = (sourceTxHex: string, vout: number): Utxo => {
  const parsed = parseTx(sourceTxHex)
  return { txid: parsed.txid, vout, satoshis: parsed.outputs[vout].satoshis, script: bytesToHex(parsed.outputs[vout].script), sourceTxHex }
}

// maker holds 10_000 units of token A
const makerTokenScript = buildStasScript(pkhOfKey(makerKey), new Uint8Array(0), tailA)
const makerTokenUtxo = utxoFromSource(fakeSourceTx(makerTokenScript, 10_000n), 0)
// taker holds 500_000 units of token B
const takerTokenScript = buildStasScript(pkhOfKey(takerKey), new Uint8Array(0), tailB)
const takerTokenUtxo = utxoFromSource(fakeSourceTx(takerTokenScript, 500_000n), 0)
const fundingUtxo = (n: bigint) => utxoFromSource(fakeSourceTx(p2pkh(pkhOfKey(fundKey)), n), 0)

// --- 1. descriptor round-trip ------------------------------------------------
const wantedTail = parseStasScript(bytesToHex(takerTokenScript))
const d0 = { requestedScriptHash: wantedTail.persistentHash, receiveAddr: pkhOfKey(makerKey), rateNumerator: 39142, rateDenominator: 100 }
const enc = encodeSwapDescriptor(d0)
const dec = decodeSwapDescriptor(enc)
assert(eq(dec.requestedScriptHash, d0.requestedScriptHash) && dec.rateNumerator === 39142 && dec.rateDenominator === 100)
assert.equal(requiredWantedAmount(100n, 39142, 100), 39142n)
assert.equal(requiredWantedAmount(7n, 39142, 100), 2739n) // floor(7*391.42)
console.log('✓ descriptor round-trip + rate math')

// --- 2. offer build ------------------------------------------------------------
const offer = buildOfferTx({
  tokenUtxo: makerTokenUtxo,
  ownerWif: makerKey.toWif([0xef]),
  fundingUtxo: fundingUtxo(50_000n),
  fundingWif: fundKey.toWif([0xef]),
  requestedTokenScriptHex: bytesToHex(takerTokenScript),
  receiveAddrHex: bytesToHex(pkhOfKey(makerKey)),
  rateNumerator: 39142,
  rateDenominator: 100,
  feePerKb: 50,
})
const offerParsed = parseStasScript(offer.swapScriptHex)
assert(eq(offerParsed.owner, EMPTY_HASH160), 'offer owner should be EMPTY_HASH160')
assert.equal(offerParsed.var2[0], 0x01)
assert(eq(parseStasScript(offer.swapScriptHex).tail, parseStasScript(makerTokenUtxo.script).tail), 'tail must be preserved')
const offerTx = parseTx(offer.built.rawHex)
assert.equal(offerTx.outputs[0].satoshis, 10_000n, 'token satoshis conserved at offer')
console.log('✓ offer tx built:', offer.built.txid.slice(0, 16) + '…', `${offer.built.rawHex.length / 2}B`)

// --- 3. pieces reconstruction invariant ---------------------------------------
const offerUtxo = utxoFromSource(offer.built.rawHex, 0)
const [before, after] = txPieces(offerUtxo.sourceTxHex, 0)
const rebuilt = concat(before, hexToBytes(offerUtxo.script), after)
assert(eq(rebuilt, hexToBytes(offer.built.rawHex)), 'pieces + script must reconstruct the source tx byte-for-byte')
console.log('✓ counterparty piece excision/reconstruction')

// --- 4. partial take ------------------------------------------------------------
const take = buildTakeTx({
  makerUtxo: offerUtxo,
  takerUtxo: takerTokenUtxo,
  takerWif: takerKey.toWif([0xef]),
  fundingUtxo: fundingUtxo(100_000n),
  fundingWif: fundKey.toWif([0xef]),
  takeAmount: 700n, // partial: 700 of 10 000
  feePerKb: 50,
})
assert.equal(take.makerRemainder, 9_300n)
const takeTx = parseTx(take.built.rawHex)
const wantedRequired = requiredWantedAmount(700n, 39142, 100)
assert.equal(takeTx.outputs[0].satoshis, wantedRequired, 'out0 = wanted asset to maker')
assert.equal(takeTx.outputs[1].satoshis, 700n, 'out1 = offered asset to taker')
assert.equal(takeTx.outputs[2].satoshis, 9_300n, 'out2 = maker remainder')
const remainder = parseStasScript(bytesToHex(takeTx.outputs[2].script))
assert(eq(remainder.var2, offerParsed.var2), 'remainder inherits the swap descriptor')
assert(eq(remainder.owner, offerParsed.owner), 'remainder inherits the owner field')
// taker remainder of token B
assert.equal(takeTx.outputs[3].satoshis, 500_000n - wantedRequired, 'out3 = taker remainder')
// token-satoshi conservation per asset
assert.equal(takeTx.outputs[1].satoshis + takeTx.outputs[2].satoshis, 10_000n, 'asset A conserved')
assert.equal(takeTx.outputs[0].satoshis + takeTx.outputs[3].satoshis, 500_000n, 'asset B conserved')
assert(take.built.efHex.startsWith(bytesToHex(serializeTx(take.built.tx)).slice(0, 8) + '0000000000ef'), 'EF marker present')
console.log('✓ partial take tx built:', take.built.txid.slice(0, 16) + '…', `${take.built.rawHex.length / 2}B; remainder=${take.makerRemainder}`)

// --- 5. cancel remainder --------------------------------------------------------
const remainderUtxo = utxoFromSource(take.built.rawHex, 2)
const cancel = buildCancelTx({
  makerUtxo: remainderUtxo,
  receiveWif: makerKey.toWif([0xef]),
  fundingUtxo: fundingUtxo(50_000n),
  fundingWif: fundKey.toWif([0xef]),
  feePerKb: 50,
})
const cancelTx = parseTx(cancel.built.rawHex)
const back = parseStasScript(bytesToHex(cancelTx.outputs[0].script))
assert(eq(back.owner, pkhOfKey(makerKey)), 'cancel sends back to receiveAddr')
assert.equal(cancelTx.outputs[0].satoshis, 9_300n, 'cancel preserves amount')
console.log('✓ cancel tx built:', cancel.built.txid.slice(0, 16) + '…')

// --- 6. wallet builders + offline send benchmark ----------------------------
const p2pkhInput = fundingUtxo(500_000n)
const sendA = buildP2pkhSend({
  utxos: [p2pkhInput], wif: fundKey.toWif([0xef]),
  outputs: [{ pkh: pkhOfKey(makerKey), satoshis: 10_000n }],
  changePkh: pkhOfKey(fundKey), feePerKb: 50,
})
const sendB = buildP2pkhSend({
  utxos: [p2pkhInput], wif: fundKey.toWif([0xef]),
  outputs: [{ pkh: pkhOfKey(makerKey), satoshis: 10_000n }],
  changePkh: pkhOfKey(fundKey), feePerKb: 50,
})
assert.equal(sendA.txid, sendB.txid, 'P2PKH txid should be deterministic')
assert.equal(parseTx(sendA.rawHex).outputs.length, 2)
assert(sendA.efHex.includes('0000000000ef'), 'P2PKH EF marker present')
console.log('✓ P2PKH send deterministic + EF serialized')

const split = buildSplitTx({
  utxos: [fundingUtxo(100_000n)], wif: fundKey.toWif([0xef]), count: 10, satoshisEach: 1_000n, feePerKb: 50,
})
const splitTx = parseTx(split.rawHex)
assert.equal(splitTx.outputs.length, 11, 'split should include count outputs plus change')
assert.equal(splitTx.outputs.slice(0, 10).reduce((s, o) => s + o.satoshis, 0n), 10_000n)
assert(splitTx.outputs[10].satoshis < 90_000n, 'split change must account for fee')
console.log('✓ split output count + change math')

const splitMulti = buildSplitTx({
  utxos: [fundingUtxo(20_000n), fundingUtxo(30_000n)], wif: fundKey.toWif([0xef]),
  count: 10, satoshisEach: 1_000n, feePerKb: 50,
})
const splitMultiTx = parseTx(splitMulti.rawHex)
assert.equal(splitMultiTx.outputs.length, 11)
assert(splitMultiTx.outputs[10].satoshis > 0n)
console.log('✓ multi-input split change math')

const efRoundTrip = serializeTxEF(split.tx)
assert.equal(efToRaw(bytesToHex(efRoundTrip)), split.rawHex)
assert.equal(arcadeBatchBody([bytesToHex(efRoundTrip), bytesToHex(efRoundTrip)]).length, efRoundTrip.length * 2)
console.log('✓ EF-to-raw conversion + Arcade batch body length')

if (config.walletWif) {
  const walletPkh = pkhOfKey(PrivateKey.fromWif(config.walletWif))
  const walletSourceTx = {
    version: 2,
    inputs: [{ txid: '22'.repeat(32), vout: 0, script: new Uint8Array([0x51]), sequence: 0xffffffff, prevSatoshis: 0n, prevScript: new Uint8Array(0) }],
    outputs: [
      { satoshis: 1_000n, script: p2pkh(walletPkh) },
    ],
    lockTime: 0,
  }
  const sourceHex = bytesToHex(serializeTx(walletSourceTx))
  const sourceTxid = parseTx(sourceHex).txid
  const walletRawTx = {
    version: 2,
    inputs: [{ txid: sourceTxid, vout: 0, script: new Uint8Array([0x51]), sequence: 0xffffffff, prevSatoshis: 0n, prevScript: new Uint8Array(0) }],
    outputs: [
      { satoshis: 777n, script: p2pkh(walletPkh) },
      { satoshis: 333n, script: p2pkh(pkhOfKey(makerKey)) },
    ],
    lockTime: 0,
  }
  importTx(sourceHex)
  const walletImported = importTx(bytesToHex(serializeTxEF(walletRawTx)))
  assert.equal(walletImported.added, 1)
  assert.equal(listUtxos().filter((row) => row.txid === walletImported.txid && row.kind === 'p2pkh').length, 1)
  assert.equal(listUtxos({ unspentOnly: false }).find((row) => row.txid === sourceTxid)?.spentBy, walletImported.txid)
  markSpent([{ txid: walletImported.txid, vout: 0 }], '33'.repeat(32))
  assert.equal(listUtxos().some((row) => row.txid === walletImported.txid && row.vout === 0), false)
  removeTx(walletImported.txid)
  removeTx(sourceTxid)
  console.log('✓ local wallet import ownership + markSpent')
}

const issued = buildStasIssueTx({
  fundingUtxos: [fundingUtxo(20_000n), fundingUtxo(20_000n)],
  wif: fundKey.toWif([0xef]), toPkh: pkhOfKey(fundKey), amount: 1_000n, count: 3, feePerKb: 50,
})
const issuedTx = parseTx(issued.rawHex)
assert.equal(issuedTx.outputs.length, 4)
for (const output of issuedTx.outputs.slice(0, 3)) {
  const issuedStas = parseStasScript(bytesToHex(output.script))
  assert(eq(issuedStas.owner, pkhOfKey(fundKey)), 'issued STAS owner')
}
console.log('✓ multi-output STAS issue')

const transferred = buildStasTransferTx({
  tokenUtxo: makerTokenUtxo, ownerWif: makerKey.toWif([0xef]),
  fundingUtxo: fundingUtxo(50_000n), fundingWif: fundKey.toWif([0xef]),
  toPkh: pkhOfKey(takerKey), amount: 7_000n, feePerKb: 50,
})
const transferredOut = parseStasScript(bytesToHex(parseTx(transferred.rawHex).outputs[0].script))
assert(eq(transferredOut.owner, pkhOfKey(takerKey)), 'STAS transfer out0 owner')
assert(eq(transferredOut.tail, tailA), 'STAS transfer preserves tail')
console.log('✓ synthetic STAS transfer owner + tail')

const benchUtxos = Array.from({ length: 200 }, (_, i) => {
  const script = p2pkh(pkhOfKey(fundKey))
  return utxoFromSource(fakeSourceTx(script, 10_000n + BigInt(i)), 0)
})
const bench = await runSendBench({
  wif: fundKey.toWif([0xef]), utxos: benchUtxos, mode: 'p2pkh',
  toPkh: pkhOfKey(makerKey), feePerKb: 50, concurrency: 32, broadcast: false, batchSize: 100,
  satoshisEach: 1_000n,
})
assert.equal(bench.count, 200)
assert.equal(bench.accepted, 0)
console.log('✓ offline send benchmark:', bench.count, 'transactions')

console.log('\nALL SELF-TESTS PASSED')

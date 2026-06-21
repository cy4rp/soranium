import express from 'express'
import { z } from 'zod'
import { config } from './config.js'
import { arcStatus, arcSubmit, ArcError } from './arc.js'
import { buildCancelTx, buildOfferTx, buildTakeTx, Utxo } from './stas/swap.js'
import { parseStasScript } from './stas/script.js'
import { decodeSwapDescriptor, requiredWantedAmount } from './stas/descriptor.js'
import { getOffer, insertOffer, listOffers, setOfferStatus } from './orderbook.js'
import { tokensForWif } from './bench/fixtures.js'
import { startBench, getBench } from './bench/runner.js'
import { PrivateKey } from '@bsv/sdk'
import { pkhOfKey, pkhToTestnetAddress } from './keys.js'
import { signerBackend } from './fastsign.js'
import { bytesToHex, hexToBytes } from './bytes.js'

const app = express()
app.use(express.json({ limit: '20mb' })) // sourceTxHex payloads can be large

const utxoSchema = z.object({
  txid: z.string().length(64),
  vout: z.number().int().nonnegative(),
  satoshis: z.union([z.string(), z.number()]).transform((v) => BigInt(v)),
  script: z.string().min(2),
  sourceTxHex: z.string().min(20),
})

const toUtxo = (u: z.infer<typeof utxoSchema>): Utxo => ({ ...u })

const handle = (fn: express.RequestHandler): express.RequestHandler => async (req, res, next) => {
  try { await fn(req, res, next) } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'validation', issues: e.issues })
    if (e instanceof ArcError) return res.status(502).json({ error: 'arc', httpStatus: e.httpStatus, body: e.body })
    res.status(400).json({ error: (e as Error).message })
  }
}

// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => res.json({ ok: true, arcUrl: config.arcUrl, network: config.network, signer: signerBackend() }))

/** Inspect any STAS locking script: owner, var2 action, descriptor, persistent hash. */
app.post('/inspect', handle(async (req, res) => {
  const { scriptHex } = z.object({ scriptHex: z.string() }).parse(req.body)
  const s = parseStasScript(scriptHex)
  const action = s.var2.length === 0 ? 'plain' : s.var2[0] === 1 ? 'swap' : s.var2[0] === 2 ? 'frozen' : 'data'
  res.json({
    owner: bytesToHex(s.owner),
    action,
    var2: bytesToHex(s.var2),
    persistentScriptHash: bytesToHex(s.persistentHash),
    protoId: s.protoId ? bytesToHex(s.protoId) : null,
    descriptor: action === 'swap' ? serializeDescriptor(s.var2) : null,
  })
}))

const serializeDescriptor = (var2: Uint8Array) => {
  const d = decodeSwapDescriptor(var2)
  return {
    requestedScriptHash: bytesToHex(d.requestedScriptHash),
    receiveAddr: bytesToHex(d.receiveAddr),
    rateNumerator: d.rateNumerator,
    rateDenominator: d.rateDenominator,
    rate: d.rateDenominator ? d.rateNumerator / d.rateDenominator : null,
    next: d.next ? bytesToHex(d.next) : null,
  }
}

/** Maker: create an on-chain swap offer (installs a swap descriptor in var2). */
app.post('/offers', handle(async (req, res) => {
  const body = z.object({
    tokenUtxo: utxoSchema,
    ownerWif: z.string(),
    fundingUtxo: utxoSchema,
    fundingWif: z.string(),
    requestedTokenScriptHex: z.string(),
    receiveAddrHex: z.string().length(40),
    rateNumerator: z.number().int().nonnegative(),
    rateDenominator: z.number().int().nonnegative(),
    nextVar2Hex: z.string().optional(),
    swapOwnerHex: z.string().length(40).optional(),
    noteHex: z.string().optional(),
    broadcast: z.boolean().default(true),
  }).parse(req.body)

  const { built, descriptor, swapScriptHex } = buildOfferTx({
    ...body,
    tokenUtxo: toUtxo(body.tokenUtxo),
    fundingUtxo: toUtxo(body.fundingUtxo),
    feePerKb: config.feePerKb,
  })

  let arc = null
  if (body.broadcast) arc = await arcSubmit(built.efHex)

  const offer = insertOffer({
    txid: built.txid,
    vout: 0,
    satoshis: body.tokenUtxo.satoshis.toString(),
    script: swapScriptHex,
    source_tx: built.rawHex,
    requested_hash: bytesToHex(descriptor.requestedScriptHash),
    receive_addr: bytesToHex(descriptor.receiveAddr),
    rate_num: descriptor.rateNumerator,
    rate_den: descriptor.rateDenominator,
    parent_id: null,
  })

  res.status(201).json({ offer, txid: built.txid, rawHex: built.rawHex, arc })
}))

/** Order book. ?status=open|filled|cancelled */
app.get('/offers', handle(async (req, res) => {
  res.json({ offers: listOffers(req.query.status as string | undefined) })
}))

app.get('/offers/:id', handle(async (req, res) => {
  const offer = getOffer(String(req.params.id))
  if (!offer) return res.status(404).json({ error: 'offer not found' })
  res.json({ offer })
}))

/** Quote: how much of the wanted asset a given take requires. */
app.get('/offers/:id/quote', handle(async (req, res) => {
  const offer = getOffer(String(req.params.id))
  if (!offer) return res.status(404).json({ error: 'offer not found' })
  const take = BigInt((req.query.takeAmount as string) ?? offer.satoshis)
  res.json({
    takeAmount: take.toString(),
    requiredWantedAmount: requiredWantedAmount(take, offer.rate_num, offer.rate_den).toString(),
    offerRemaining: offer.satoshis,
  })
}))

/** Taker: execute (fully or partially) a standing offer. */
app.post('/offers/:id/take', handle(async (req, res) => {
  const offer = getOffer(String(req.params.id))
  if (!offer) return res.status(404).json({ error: 'offer not found' })
  if (offer.status !== 'open') return res.status(409).json({ error: `offer is ${offer.status}` })

  const body = z.object({
    takerUtxo: utxoSchema,
    takerWif: z.string(),
    fundingUtxo: utxoSchema,
    fundingWif: z.string(),
    takeAmount: z.union([z.string(), z.number()]).transform((v) => BigInt(v)).optional(),
    wantedAmount: z.union([z.string(), z.number()]).transform((v) => BigInt(v)).optional(),
    takerReceivePkhHex: z.string().length(40).optional(),
    noteHex: z.string().optional(),
    broadcast: z.boolean().default(true),
  }).parse(req.body)

  const { built, makerRemainder, takerRemainder, remainderVout } = buildTakeTx({
    ...body,
    makerUtxo: {
      txid: offer.txid, vout: offer.vout, satoshis: BigInt(offer.satoshis),
      script: offer.script, sourceTxHex: offer.source_tx,
    },
    takerUtxo: toUtxo(body.takerUtxo),
    fundingUtxo: toUtxo(body.fundingUtxo),
    feePerKb: config.feePerKb,
  })

  let arc = null
  if (body.broadcast) arc = await arcSubmit(built.efHex)

  setOfferStatus(offer.id, 'filled')
  let remainderOffer = null
  if (makerRemainder > 0n && remainderVout !== undefined) {
    const remainderScript = bytesToHex(built.tx.outputs[remainderVout].script)
    const d = decodeSwapDescriptor(parseStasScript(hexToBytes(remainderScript)).var2)
    remainderOffer = insertOffer({
      txid: built.txid, vout: remainderVout, satoshis: makerRemainder.toString(),
      script: remainderScript, source_tx: built.rawHex,
      requested_hash: bytesToHex(d.requestedScriptHash), receive_addr: bytesToHex(d.receiveAddr),
      rate_num: d.rateNumerator, rate_den: d.rateDenominator, parent_id: offer.id,
    })
  }

  res.json({
    txid: built.txid, rawHex: built.rawHex, arc,
    makerRemainder: makerRemainder.toString(), takerRemainder: takerRemainder.toString(),
    remainderOffer,
  })
}))

/** Maker: cancel a standing offer (spendType 4). */
app.post('/offers/:id/cancel', handle(async (req, res) => {
  const offer = getOffer(String(req.params.id))
  if (!offer) return res.status(404).json({ error: 'offer not found' })
  if (offer.status !== 'open') return res.status(409).json({ error: `offer is ${offer.status}` })

  const body = z.object({
    receiveWif: z.string(),
    fundingUtxo: utxoSchema,
    fundingWif: z.string(),
    broadcast: z.boolean().default(true),
  }).parse(req.body)

  const { built } = buildCancelTx({
    makerUtxo: {
      txid: offer.txid, vout: offer.vout, satoshis: BigInt(offer.satoshis),
      script: offer.script, sourceTxHex: offer.source_tx,
    },
    receiveWif: body.receiveWif,
    fundingUtxo: toUtxo(body.fundingUtxo),
    fundingWif: body.fundingWif,
    feePerKb: config.feePerKb,
  })

  let arc = null
  if (body.broadcast) arc = await arcSubmit(built.efHex)
  setOfferStatus(offer.id, 'cancelled')
  res.json({ txid: built.txid, rawHex: built.rawHex, arc })
}))

/** ARC transaction status passthrough. */
app.get('/tx/:txid', handle(async (req, res) => {
  res.json(await arcStatus(String(req.params.txid)))
}))

app.use(express.static('public'))

// --- benchmark endpoints -----------------------------------------------------

/** Step 1: load a WIF — returns address + the STAS token set it holds (fixtures). */
app.post('/bench/wallet', handle(async (req, res) => {
  const { wif, tailBytes } = z.object({ wif: z.string(), tailBytes: z.number().int().min(64).max(25000).default(1024) }).parse(req.body)
  const key = PrivateKey.fromWif(wif) // throws on invalid WIF
  const pkh = pkhOfKey(key)
  res.json({
    address: pkhToTestnetAddress(pkh),
    pkh: bytesToHex(pkh),
    tokens: tokensForWif(wif, tailBytes),
  })
}))

/** Step 3: start a benchmark run. */
app.post('/bench/start', handle(async (req, res) => {
  const body = z.object({
    wif: z.string(),
    offeredTokenSeed: z.number().int().min(1).max(3),
    tailBytes: z.number().int().min(64).max(25000).default(1024),
    totalSwaps: z.number().int().min(100).max(2_000_000).default(10000),
    workers: z.number().int().min(1).max(64).default(0).or(z.literal(0)),
    takeAmount: z.string().default('1000'),
    rateNumerator: z.number().int().default(39142),
    rateDenominator: z.number().int().default(100),
    broadcast: z.boolean().default(false),
  }).parse(req.body)
  PrivateKey.fromWif(body.wif)
  const result = startBench({
    wif: body.wif,
    offeredTokenSeed: body.offeredTokenSeed,
    wantedTokenSeed: (body.offeredTokenSeed % 3) + 1,
    tailBytes: body.tailBytes,
    totalSwaps: body.totalSwaps,
    workers: body.workers,
    takeAmount: body.takeAmount,
    rateNumerator: body.rateNumerator,
    rateDenominator: body.rateDenominator,
    feePerKb: config.feePerKb,
    arcUrl: body.broadcast ? config.arcUrl : undefined,
  })
  res.status(202).json({ id: result.id, workersUsed: result.workersUsed, cpuCount: result.cpuCount })
}))

/** SSE stream of live samples. */
app.get('/bench/:id/events', (req, res) => {
  const run = getBench(String(req.params.id))
  if (!run) return res.status(404).end()
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  send('state', run.result)
  const onSample = (s: unknown) => send('sample', s)
  const onEnd = (r: unknown) => { send('end', r); res.end() }
  run.events.on('sample', onSample)
  run.events.once('end', onEnd)
  if (run.result.state === 'done' || run.result.state === 'error') onEnd(run.result)
  req.on('close', () => { run.events.off('sample', onSample); run.events.off('end', onEnd) })
})

/** Step 4: final result. */
app.get('/bench/:id', handle(async (req, res) => {
  const run = getBench(String(req.params.id))
  if (!run) return res.status(404).json({ error: 'bench not found' })
  res.json(run.result)
}))

app.listen(config.port, () => {
  console.log(`stas3-swap-api listening on :${config.port} → ARC ${config.arcUrl} (${config.network})`)
})

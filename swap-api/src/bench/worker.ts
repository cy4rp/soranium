/**
 * Benchmark worker: builds + signs real take-swap transactions in a tight loop
 * over its assigned fixture range. Reports progress batches to the runner.
 * Every transaction goes through the production buildTakeTx path (parse,
 * descriptor decode, piece excision, 2 sighash preimages, 2 ECDSA signatures,
 * unlock construction, raw + EF serialization).
 */
import { parentPort, workerData } from 'node:worker_threads'
import { buildTakeTx } from '../stas/swap.js'
import { generateFixtures, FixtureSetParams } from './fixtures.js'

interface WorkerInput {
  fixtureParams: FixtureSetParams
  takeAmount: string
  feePerKb: number
  reportEvery: number
  arcUrl?: string // when set, also broadcast EF to ARC (fire-and-forget batches)
}

const input = workerData as WorkerInput

const run = async () => {
  const fixtures = generateFixtures(input.fixtureParams)
  parentPort!.postMessage({ type: 'ready', fixtures: fixtures.length })

  // wait for the start signal so all workers begin on the same clock edge
  await new Promise<void>((resolve) => parentPort!.once('message', () => resolve()))

  const takeAmount = BigInt(input.takeAmount)
  const latencies: number[] = [] // µs, reservoir-capped
  let done = 0
  let bytesOut = 0
  let lastReport = process.hrtime.bigint()
  const pendingBroadcasts: Promise<unknown>[] = []

  for (const f of fixtures) {
    const t0 = process.hrtime.bigint()
    const { built } = buildTakeTx({
      makerUtxo: f.makerUtxo,
      takerUtxo: f.takerUtxo,
      takerWif: input.fixtureParams.wif,
      fundingUtxo: f.fundingUtxo,
      fundingWif: input.fixtureParams.wif,
      takeAmount,
      feePerKb: input.feePerKb,
    })
    const dt = Number(process.hrtime.bigint() - t0) / 1000
    done++
    bytesOut += built.efHex.length / 2
    if (latencies.length < 20_000) latencies.push(dt)

    if (input.arcUrl) {
      pendingBroadcasts.push(
        fetch(`${input.arcUrl}/v1/tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rawTx: built.efHex }),
        }).catch(() => null),
      )
      if (pendingBroadcasts.length >= 64) {
        await Promise.all(pendingBroadcasts.splice(0))
      }
    }

    if (done % input.reportEvery === 0) {
      const now = process.hrtime.bigint()
      parentPort!.postMessage({ type: 'progress', done, windowNs: Number(now - lastReport), bytesOut })
      lastReport = now
    }
  }
  if (pendingBroadcasts.length) await Promise.all(pendingBroadcasts)

  latencies.sort((a, b) => a - b)
  const pct = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? 0
  parentPort!.postMessage({
    type: 'done', done, bytesOut,
    p50us: pct(0.5), p90us: pct(0.9), p99us: pct(0.99),
    minUs: latencies[0] ?? 0, maxUs: latencies[latencies.length - 1] ?? 0,
  })
}

run().catch((e) => parentPort!.postMessage({ type: 'error', message: (e as Error).message }))

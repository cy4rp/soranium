/**
 * Benchmark runner: spawns a worker pool, synchronizes the start edge,
 * aggregates progress into a time series, and computes the final report.
 */
import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

export interface BenchConfig {
  wif: string
  offeredTokenSeed: number
  wantedTokenSeed: number
  tailBytes: number
  totalSwaps: number
  workers: number
  takeAmount: string
  rateNumerator: number
  rateDenominator: number
  feePerKb: number
  arcUrl?: string
}

export interface BenchSample { tMs: number; done: number; rate: number }

export interface BenchResult {
  id: string
  config: Omit<BenchConfig, 'wif'>
  state: 'preparing' | 'running' | 'done' | 'error'
  startedAt?: number
  elapsedMs?: number
  totalDone: number
  swapsPerSec?: number
  peakSwapsPerSec?: number
  bytesOut: number
  sigOpsPerSec?: number
  p50us?: number; p90us?: number; p99us?: number; minUs?: number; maxUs?: number
  samples: BenchSample[]
  error?: string
  workersUsed: number
  cpuCount: number
  target: number
  verdict?: string
}

const runs = new Map<string, { result: BenchResult; events: EventEmitter }>()

const workerUrl = (): URL => new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url)
const workerExecArgv = (): string[] => (import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : [])

export const startBench = (cfg: BenchConfig): BenchResult => {
  const id = randomUUID()
  const workers = Math.max(1, Math.min(cfg.workers || cpus().length, 64))
  const { wif: _wif, ...publicCfg } = cfg
  const result: BenchResult = {
    id, config: publicCfg, state: 'preparing', totalDone: 0, bytesOut: 0,
    samples: [], workersUsed: workers, cpuCount: cpus().length, target: 10_000,
  }
  const events = new EventEmitter()
  runs.set(id, { result, events })

  const perWorker = Math.ceil(cfg.totalSwaps / workers)
  const pool: Worker[] = []
  let ready = 0
  let finished = 0
  const finals: { p50us: number; p90us: number; p99us: number; minUs: number; maxUs: number; done: number }[] = []
  let startNs = 0n
  let lastDone = 0
  let lastTick = 0

  const tick = setInterval(() => {
    if (result.state !== 'running') return
    const tMs = Number(process.hrtime.bigint() - startNs) / 1e6
    const rate = ((result.totalDone - lastDone) / Math.max(1, tMs - lastTick)) * 1000
    lastDone = result.totalDone
    lastTick = tMs
    const sample = { tMs: Math.round(tMs), done: result.totalDone, rate: Math.round(rate) }
    result.samples.push(sample)
    result.peakSwapsPerSec = Math.max(result.peakSwapsPerSec ?? 0, sample.rate)
    events.emit('sample', sample)
  }, 200)

  const finish = (error?: string) => {
    clearInterval(tick)
    if (error) {
      result.state = 'error'
      result.error = error
    } else {
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6
      result.state = 'done'
      result.elapsedMs = Math.round(elapsedMs)
      result.swapsPerSec = Math.round((result.totalDone / elapsedMs) * 1000)
      result.sigOpsPerSec = result.swapsPerSec * 2 // taker + funding signatures per swap
      const all = finals
      const wAvg = (k: 'p50us' | 'p90us' | 'p99us') =>
        Math.round(all.reduce((s, f) => s + f[k] * f.done, 0) / Math.max(1, all.reduce((s, f) => s + f.done, 0)))
      result.p50us = wAvg('p50us'); result.p90us = wAvg('p90us'); result.p99us = wAvg('p99us')
      result.minUs = Math.min(...all.map((f) => f.minUs))
      result.maxUs = Math.max(...all.map((f) => f.maxUs))
      result.verdict = result.swapsPerSec >= result.target
        ? `PASS — ${result.swapsPerSec.toLocaleString()} swaps/s ≥ 10,000`
        : `MEASURED ${result.swapsPerSec.toLocaleString()} swaps/s on ${result.workersUsed} worker(s) / ${result.cpuCount} core(s) — linear scaling needs ≈ ${Math.ceil(10_000 / (result.swapsPerSec / result.workersUsed))} cores`
    }
    events.emit('end', result)
    for (const w of pool) void w.terminate()
  }

  for (let i = 0; i < workers; i++) {
    const count = Math.min(perWorker, cfg.totalSwaps - i * perWorker)
    if (count <= 0) break
    const w = new Worker(workerUrl(), {
      execArgv: workerExecArgv(),
      workerData: {
        fixtureParams: {
          wif: cfg.wif, offeredTokenSeed: cfg.offeredTokenSeed, wantedTokenSeed: cfg.wantedTokenSeed,
          tailBytes: cfg.tailBytes, count, rateNumerator: cfg.rateNumerator, rateDenominator: cfg.rateDenominator,
        },
        takeAmount: cfg.takeAmount,
        feePerKb: cfg.feePerKb,
        reportEvery: 50,
        arcUrl: cfg.arcUrl,
      },
    })
    let workerDone = 0
    w.on('message', (m: Record<string, number | string>) => {
      if (m.type === 'ready') {
        ready++
        if (ready === pool.length) {
          result.state = 'running'
          result.startedAt = Date.now()
          startNs = process.hrtime.bigint()
          events.emit('running', { workers: pool.length })
          for (const p of pool) p.postMessage('start')
        }
      } else if (m.type === 'progress') {
        result.totalDone += (m.done as number) - workerDone
        workerDone = m.done as number
        result.bytesOut = pool.length ? result.bytesOut : result.bytesOut
      } else if (m.type === 'done') {
        result.totalDone += (m.done as number) - workerDone
        workerDone = m.done as number
        result.bytesOut += m.bytesOut as number
        finals.push(m as never)
        finished++
        if (finished === pool.length) finish()
      } else if (m.type === 'error') {
        finish(String(m.message))
      }
    })
    w.on('error', (e: Error) => finish(e.message))
    pool.push(w)
  }
  if (pool.length === 0) finish('no workers spawned')

  return result
}

export const getBench = (id: string) => runs.get(id)

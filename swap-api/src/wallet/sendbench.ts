import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import { arcStatus, arcSubmit, arcSubmitBatch, ArcBatchUnavailableError } from '../arc.js'
import { config } from '../config.js'
import type { Utxo } from '../stas/swap.js'
import { recordBroadcast } from './store.js'

export interface SendBenchParams {
  wif: string
  utxos: Utxo[]
  fundingUtxos?: Utxo[]
  mode: 'p2pkh' | 'stas'
  toPkh: Uint8Array | string
  feePerKb: number
  concurrency: number
  broadcast: boolean
  batchSize: number
  satoshisEach?: bigint
  workers?: number
  pipeline?: boolean
  verifySample?: boolean
}

interface BuiltItem { index: number; txid: string; rawHex: string; efHex: string; us: number }

export interface SendBenchReport {
  network: typeof config.network
  mode: SendBenchParams['mode']
  count: number
  workers: number
  buildTps: number
  buildP50us: number
  buildP99us: number
  broadcastTps: number
  endToEndTps: number
  accepted: number
  rejected: number
  elapsedMs: number
  errors: string[]
  txids: string[]
  verdict: { target: 10000; buildMeetsTarget: boolean; broadcastMeetsTarget: boolean }
  verificationSample?: Record<string, number>
  pipeline?: boolean
}

const percentile = (values: number[], q: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

const workerUrl = (): URL => new URL(import.meta.url.endsWith('.ts') ? './sendbench-worker.ts' : './sendbench-worker.js', import.meta.url)
const workerExecArgv = (): string[] => (import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : [])

const buildWithWorkers = async (p: SendBenchParams, onChunk?: (chunk: BuiltItem[]) => void): Promise<{ built: BuiltItem[]; elapsedMs: number }> => {
  const workers = Math.max(1, Math.min(p.workers ?? availableParallelism(), p.utxos.length || 1))
  const compact = (utxo: Utxo): Utxo => ({ ...utxo, sourceTxHex: p.mode === 'stas' ? utxo.sourceTxHex : '' })
  const pairs = p.utxos.map((utxo, index) => ({
    index, utxo: compact(utxo), fundingUtxo: p.fundingUtxos?.[index] ? compact(p.fundingUtxos[index]) : undefined,
  }))
  const slices = Array.from({ length: workers }, (_, i) =>
    pairs.slice(Math.floor(i * pairs.length / workers), Math.floor((i + 1) * pairs.length / workers))).filter((x) => x.length)
  const all: BuiltItem[] = []
  const started = process.hrtime.bigint()
  await Promise.all(slices.map((slice) => new Promise<void>((resolve, reject) => {
    const worker = new Worker(workerUrl(), {
      execArgv: workerExecArgv(),
      workerData: {
        wif: p.wif, pairs: slice, mode: p.mode,
        toPkh: typeof p.toPkh === 'string' ? Uint8Array.from(Buffer.from(p.toPkh, 'hex')) : p.toPkh,
        feePerKb: p.feePerKb, satoshisEach: p.satoshisEach, chunkSize: Math.max(1, p.batchSize),
      },
    })
    worker.on('message', (message: { type: string; built?: BuiltItem[]; message?: string }) => {
      if (message.type === 'chunk' && message.built) {
        all.push(...message.built)
        onChunk?.(message.built)
      }
      else if (message.type === 'done') { resolve(); void worker.terminate() }
      else if (message.type === 'error') reject(new Error(message.message))
    })
    worker.on('error', reject)
  })))
  return { built: all.sort((a, b) => a.index - b.index), elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 }
}

const builtTx = (item: BuiltItem): any => ({ txid: item.txid, rawHex: item.rawHex, efHex: item.efHex, tx: {} })

const broadcastBuilt = async (p: SendBenchParams, built: BuiltItem[], inputs: Utxo[][]): Promise<{ elapsedMs: number; accepted: number; rejected: number; errors: string[]; txids: string[] }> => {
  const chunks: BuiltItem[][] = []
  for (let i = 0; i < built.length; i += Math.max(1, p.batchSize)) chunks.push(built.slice(i, i + Math.max(1, p.batchSize)))
  const accepted: string[] = []
  const rejected: string[] = []
  const errors: string[] = []
  const txids: string[] = []
  let next = 0
  let aborted = false
  const started = process.hrtime.bigint()
  const submit = async (): Promise<void> => {
    while (true) {
      if (aborted) return
      const chunk = chunks[next++]
      if (!chunk) return
      try {
        const response = await arcSubmitBatch(chunk.map((item) => item.efHex))
        if (Array.isArray(response)) {
          for (let i = 0; i < chunk.length; i++) {
            const item = chunk[i]
            const row = response[i] ?? {}
            const txid = row.txid || item.txid
            txids.push(txid)
            if (String(row.txStatus ?? '').toLowerCase() === 'rejected') rejected.push(txid)
            else { accepted.push(txid); recordBroadcast(builtTx(item), inputs[item.index]) }
          }
        } else {
          for (const item of chunk) {
            accepted.push(item.txid)
            txids.push(item.txid)
            recordBroadcast(builtTx(item), inputs[item.index])
          }
        }
      } catch (error) {
        if (error instanceof ArcBatchUnavailableError) {
          for (const item of chunk) {
            try {
              const response = await arcSubmit(item.efHex)
              const txid = response.txid || item.txid
              accepted.push(txid); txids.push(txid)
              recordBroadcast(builtTx(item), inputs[item.index])
            } catch (singleError) {
              rejected.push(item.txid)
              if (errors.length < 5) errors.push((singleError as Error).message)
            }
          }
        } else {
          rejected.push(...chunk.map((item) => item.txid))
          if (errors.length < 5) errors.push((error as Error).message)
          if ((error as { httpStatus?: number }).httpStatus === 400) aborted = true
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, p.concurrency) }, submit))
  return { elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, accepted: accepted.length, rejected: rejected.length, errors, txids }
}

type BroadcastAccumulator = { accepted: string[]; rejected: string[]; errors: string[]; txids: string[]; stopped?: boolean }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const verifyAccepted = async (txids: string[], enabled: boolean): Promise<Record<string, number> | undefined> => {
  if (!enabled || !txids.length) return undefined
  await sleep(3000)
  const sample = [...txids].sort(() => Math.random() - 0.5).slice(0, 20)
  const counts: Record<string, number> = {}
  await Promise.all(sample.map(async (txid) => {
    try {
      const status = await arcStatus(txid)
      const key = String(status.txStatus ?? status.status ?? 'UNKNOWN')
      counts[key] = (counts[key] ?? 0) + 1
    } catch {
      counts.ERROR = (counts.ERROR ?? 0) + 1
    }
  }))
  return counts
}

const submitChunk = async (p: SendBenchParams, chunk: BuiltItem[], inputs: Utxo[][], acc: BroadcastAccumulator): Promise<void> => {
  if (acc.stopped) return
  try {
    const response = await arcSubmitBatch(chunk.map((item) => item.efHex))
    if (Array.isArray(response)) {
      for (let i = 0; i < chunk.length; i++) {
        const item = chunk[i]
        const row = response[i] ?? {}
        const txid = row.txid || item.txid
        acc.txids.push(txid)
        if (String(row.txStatus ?? '').toLowerCase() === 'rejected') acc.rejected.push(txid)
        else { acc.accepted.push(txid); recordBroadcast(builtTx(item), inputs[item.index]) }
      }
    } else {
      for (const item of chunk) {
        acc.accepted.push(item.txid); acc.txids.push(item.txid)
        recordBroadcast(builtTx(item), inputs[item.index])
      }
    }
  } catch (error) {
    if (error instanceof ArcBatchUnavailableError) {
      for (const item of chunk) {
        try {
          const response = await arcSubmit(item.efHex)
          const txid = response.txid || item.txid
          acc.accepted.push(txid); acc.txids.push(txid)
          recordBroadcast(builtTx(item), inputs[item.index])
        } catch (singleError) {
          acc.rejected.push(item.txid)
          if (acc.errors.length < 5) acc.errors.push((singleError as Error).message)
        }
      }
    } else {
      acc.rejected.push(...chunk.map((item) => item.txid))
      if (acc.errors.length < 5) acc.errors.push((error as Error).message)
      if ((error as { httpStatus?: number }).httpStatus === 400) acc.stopped = true
    }
  }
}

export const runSendBench = async (p: SendBenchParams): Promise<SendBenchReport> => {
  if (p.utxos.length > 100000) throw new Error('count exceeds 100000')
  if (p.mode === 'stas' && (!p.fundingUtxos || p.fundingUtxos.length < p.utxos.length)) throw new Error('stas mode requires one funding UTXO per token UTXO')
  const started = process.hrtime.bigint()
  const inputs = p.utxos.map((utxo, index) => p.mode === 'stas' ? [utxo, p.fundingUtxos![index]] : [utxo])
  const pipelineAcc: BroadcastAccumulator = { accepted: [], rejected: [], errors: [], txids: [] }
  let pipelineActive = 0
  const pipelineQueue: BuiltItem[][] = []
  const drainPipeline = (): void => {
    while (!pipelineAcc.stopped && pipelineActive < Math.max(1, p.concurrency) && pipelineQueue.length) {
      const chunk = pipelineQueue.shift()!
      pipelineActive++
      const job = submitChunk(p, chunk, inputs, pipelineAcc).finally(() => {
        pipelineActive--
        drainPipeline()
      })
      void job
    }
  }
  const build = await buildWithWorkers(p, p.pipeline && p.broadcast ? (chunk) => {
    pipelineQueue.push(chunk)
    drainPipeline()
  } : undefined)
  const latencies = build.built.map((item) => item.us)
  const workers = Math.max(1, Math.min(p.workers ?? availableParallelism(), p.utxos.length || 1))
  const buildTps = build.built.length / Math.max(build.elapsedMs / 1000, 0.000001)
  if (!p.broadcast) {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    return {
      network: config.network, mode: p.mode, count: build.built.length, workers, buildTps,
      buildP50us: percentile(latencies, 0.5), buildP99us: percentile(latencies, 0.99),
      broadcastTps: 0, endToEndTps: build.built.length / Math.max(elapsedMs / 1000, 0.000001),
      accepted: 0, rejected: 0, elapsedMs: Math.round(elapsedMs), errors: [],
      txids: build.built.slice(0, 20).map((item) => item.txid),
      verdict: { target: 10000, buildMeetsTarget: buildTps >= 10000, broadcastMeetsTarget: false },
      pipeline: false,
    }
  }
  if (p.pipeline) {
    drainPipeline()
    while (pipelineActive > 0 || pipelineQueue.length > 0) {
      if (pipelineAcc.stopped) pipelineQueue.length = 0
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    const broadcastTps = pipelineAcc.accepted.length / Math.max(elapsedMs / 1000, 0.000001)
    const verificationSample = await verifyAccepted(pipelineAcc.accepted, p.verifySample !== false)
    return {
      network: config.network, mode: p.mode, count: build.built.length, workers, buildTps,
      buildP50us: percentile(latencies, 0.5), buildP99us: percentile(latencies, 0.99),
      broadcastTps, endToEndTps: broadcastTps, accepted: pipelineAcc.accepted.length,
      rejected: pipelineAcc.rejected.length, elapsedMs: Math.round(elapsedMs),
      errors: pipelineAcc.errors.slice(0, 5), txids: pipelineAcc.txids.slice(0, 20),
      verdict: { target: 10000, buildMeetsTarget: buildTps >= 10000, broadcastMeetsTarget: broadcastTps >= 10000 },
      verificationSample,
      pipeline: true,
    }
  }
  const broadcast = await broadcastBuilt(p, build.built, inputs)
  const totalMs = Number(process.hrtime.bigint() - started) / 1e6
  const broadcastTps = broadcast.accepted / Math.max(broadcast.elapsedMs / 1000, 0.000001)
  const verificationSample = await verifyAccepted(broadcast.txids, p.verifySample !== false)
  return {
    network: config.network, mode: p.mode, count: build.built.length, workers, buildTps,
    buildP50us: percentile(latencies, 0.5), buildP99us: percentile(latencies, 0.99),
    broadcastTps, endToEndTps: broadcast.accepted / Math.max(totalMs / 1000, 0.000001),
    accepted: broadcast.accepted, rejected: broadcast.rejected, elapsedMs: Math.round(totalMs),
    errors: broadcast.errors.slice(0, 5), txids: broadcast.txids.slice(0, 20),
    verdict: { target: 10000, buildMeetsTarget: buildTps >= 10000, broadcastMeetsTarget: broadcastTps >= 10000 },
    verificationSample,
    pipeline: Boolean(p.pipeline),
  }
}

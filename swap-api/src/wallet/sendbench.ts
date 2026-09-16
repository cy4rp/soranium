import { arcSubmit, arcSubmitBatch, ArcBatchUnavailableError, ArcSubmitResult } from '../arc.js'
import { config } from '../config.js'
import { Utxo } from '../stas/swap.js'
import { buildP2pkhSend, buildStasTransferTx } from './transfer.js'

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
}

export interface SendBenchReport {
  network: typeof config.network
  mode: SendBenchParams['mode']
  count: number
  workers: number
  buildTps: number
  buildP50us: number
  buildP99us: number
  broadcastTps: number
  accepted: number
  rejected: number
  elapsedMs: number
  errors: string[]
  txids: string[]
}

const percentile = (values: number[], q: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

const acceptedStatus = (status: string | undefined): boolean =>
  ['accepted', 'received', 'stored', 'announced_to_network', 'seen_on_network', 'success', 'mined']
    .includes((status ?? '').toLowerCase())

export const runSendBench = async (p: SendBenchParams): Promise<SendBenchReport> => {
  if (p.mode === 'stas' && (!p.fundingUtxos || p.fundingUtxos.length < p.utxos.length))
    throw new Error('stas mode requires one funding UTXO per token UTXO')
  const built: { txid: string; efHex: string }[] = []
  const latencies: number[] = []
  const buildStart = process.hrtime.bigint()
  for (let i = 0; i < p.utxos.length; i++) {
    const started = process.hrtime.bigint()
    const tx = p.mode === 'p2pkh'
      ? buildP2pkhSend({
        utxos: [p.utxos[i]], wif: p.wif,
        outputs: [{ pkh: p.toPkh, satoshis: p.satoshisEach ?? 1n }],
        changePkh: p.toPkh, feePerKb: p.feePerKb,
      })
      : buildStasTransferTx({
        tokenUtxo: p.utxos[i], ownerWif: p.wif, fundingUtxo: p.fundingUtxos![i],
        fundingWif: p.wif, toPkh: p.toPkh, amount: p.satoshisEach, feePerKb: p.feePerKb,
      })
    built.push({ txid: tx.txid, efHex: tx.efHex })
    latencies.push(Number(process.hrtime.bigint() - started) / 1000)
  }
  const buildElapsedMs = Number(process.hrtime.bigint() - buildStart) / 1e6
  if (!p.broadcast) {
    return {
      network: config.network, mode: p.mode, count: built.length, workers: 1,
      buildTps: built.length / Math.max(buildElapsedMs / 1000, 0.000001),
      buildP50us: percentile(latencies, 0.5), buildP99us: percentile(latencies, 0.99),
      broadcastTps: 0, accepted: 0, rejected: 0, elapsedMs: Math.round(buildElapsedMs),
      errors: [], txids: built.map((b) => b.txid),
    }
  }

  const accepted: string[] = []
  const rejected: string[] = []
  const errors: string[] = []
  const txids: string[] = []
  const broadcastStart = process.hrtime.bigint()
  const chunks: { txid: string; efHex: string }[][] = []
  for (let i = 0; i < built.length; i += Math.max(1, p.batchSize)) chunks.push(built.slice(i, i + Math.max(1, p.batchSize)))
  let nextChunk = 0
  const worker = async (): Promise<void> => {
    while (nextChunk < chunks.length) {
      const chunk = chunks[nextChunk++]
      let results: ArcSubmitResult[]
      try {
        results = await arcSubmitBatch(chunk.map((x) => x.efHex))
      } catch (e) {
        if (!(e instanceof ArcBatchUnavailableError)) {
          for (const item of chunk) {
            rejected.push(item.txid)
            if (errors.length < 5) errors.push((e as Error).message)
          }
          continue
        }
        results = await Promise.all(chunk.map(async (item) => {
          try { return await arcSubmit(item.efHex) }
          catch (error) {
            if (errors.length < 5) errors.push((error as Error).message)
            return { txid: item.txid, txStatus: 'REJECTED', detail: (error as Error).message }
          }
        }))
      }
      results.forEach((result, i) => {
        const txid = result.txid || chunk[i]?.txid
        if (txid) txids.push(txid)
        if (acceptedStatus(result.txStatus)) accepted.push(txid)
        else {
          rejected.push(txid)
          if (errors.length < 5 && (result.detail || result.title)) errors.push(String(result.detail ?? result.title))
        }
      })
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, p.concurrency) }, worker))
  const elapsedMs = Number(process.hrtime.bigint() - broadcastStart) / 1e6
  return {
    network: config.network, mode: p.mode, count: built.length, workers: 1,
    buildTps: built.length / Math.max(buildElapsedMs / 1000, 0.000001),
    buildP50us: percentile(latencies, 0.5), buildP99us: percentile(latencies, 0.99),
    broadcastTps: accepted.length / Math.max(elapsedMs / 1000, 0.000001),
    accepted: accepted.length, rejected: rejected.length, elapsedMs: Math.round(elapsedMs),
    errors: errors.slice(0, 5), txids: txids.slice(0, 20),
  }
}

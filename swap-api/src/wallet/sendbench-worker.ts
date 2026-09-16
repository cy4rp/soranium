import { parentPort, workerData } from 'node:worker_threads'
import type { Utxo } from '../stas/swap.js'

interface Pair { index: number; utxo: Utxo; fundingUtxo?: Utxo }
interface WorkerInput {
  wif: string
  pairs: Pair[]
  mode: 'p2pkh' | 'stas'
  toPkh: Uint8Array
  feePerKb: number
  satoshisEach?: bigint
  chunkSize: number
}

const p = workerData as WorkerInput
const { tsImport } = await import('tsx/esm/api')
const { buildP2pkhSend } = await tsImport(
  `./transfer${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`,
  import.meta.url,
)
const { buildDstasTransfer } = await tsImport(
  `./dstas${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`,
  import.meta.url,
)
const built: { index: number; txid: string; rawHex: string; efHex: string; us: number }[] = []
try {
  for (const pair of p.pairs) {
    const started = process.hrtime.bigint()
  const tx = p.mode === 'p2pkh'
      ? buildP2pkhSend({
        utxos: [pair.utxo], wif: p.wif,
        outputs: [{ pkh: p.toPkh, satoshis: p.satoshisEach ?? 1n }],
        changePkh: p.toPkh, feePerKb: p.feePerKb,
      })
      : buildDstasTransfer({
        stasUtxo: pair.utxo, feeUtxo: pair.fundingUtxo!, wif: p.wif,
        to: p.toPkh, feePerKb: p.feePerKb,
      })
    built.push({
      index: pair.index, txid: tx.txid, rawHex: tx.rawHex, efHex: tx.efHex,
      us: Number(process.hrtime.bigint() - started) / 1000,
    })
    if (built.length >= p.chunkSize) parentPort!.postMessage({ type: 'chunk', built: built.splice(0) })
  }
  if (built.length) parentPort!.postMessage({ type: 'chunk', built })
  parentPort!.postMessage({ type: 'done' })
} catch (error) {
  parentPort!.postMessage({ type: 'error', message: (error as Error).message })
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { PrivateKey } from '@bsv/sdk'
import { z } from 'zod'
import { arcStatus, arcSubmit } from '../arc.js'
import { config } from '../config.js'
import { bytesToHex } from '../bytes.js'
import { pkhOfKey, pkhToTestnetAddress, addressToPkh } from '../keys.js'
import { getChainInfo, getUtxos, getRawTx } from '../wallet/chain.js'
import { buildP2pkhSend, buildSplitTx } from '../wallet/transfer.js'
import { buildDstasIssue, buildDstasTransfer, DSTAS_MAX_DESTINATIONS_PER_TX } from '../wallet/dstas.js'
import { runSendBench } from '../wallet/sendbench.js'
import type { Utxo } from '../stas/swap.js'
import { balance as localBalance, importTx, listUtxos, recordBroadcast } from '../wallet/store.js'
import type { WalletStoreUtxo } from '../wallet/store.js'

const walletKey = (): PrivateKey => {
  if (!config.walletWif) throw new Error('WALLET_WIF is not configured')
  return PrivateKey.fromWif(config.walletWif)
}
const walletPkh = (): Uint8Array => pkhOfKey(walletKey())
const walletAddress = (): string => pkhToTestnetAddress(walletPkh())
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
const errorResult = (error: unknown) => result({ error: (error as Error).message })

const sourceUtxos = async (address: string, limit?: number): Promise<WalletStoreUtxo[]> => {
  const local = listUtxos({ limit })
  if (local.length) return local
  return []
}

const selectFunding = (utxos: Utxo[], amount: bigint): Utxo[] => {
  const selected: Utxo[] = []
  let total = 0n
  for (const u of utxos) {
    selected.push(u)
    total += u.satoshis
    if (total >= amount) return selected
  }
  throw new Error(`insufficient funds: need at least ${amount} sats`)
}

export const createMcpServer = (): McpServer => {
  const server = new McpServer({ name: 'ttn-mcp-wallet', version: '0.1.0' })
  server.registerTool('network_status', { description: 'TTN ARC and WoC health/status' }, async () => {
    try {
      const [health, policy, chain] = await Promise.all([
        fetch(`${config.arcUrl}/health`).then((r) => r.json()),
        fetch(`${config.arcUrl}/${config.arcFlavor === 'arcade' ? 'policy' : 'v1/policy'}`).then((r) => r.json()),
        getChainInfo(),
      ])
      return result({ network: config.network, arcUrl: config.arcUrl, health, policy, chain })
    } catch (e) { return errorResult(e) }
  })
  server.registerTool('wallet_info', { description: 'Wallet address and public key hash' }, async () =>
    result({ address: walletAddress(), pkh: bytesToHex(walletPkh()) }))
  server.registerTool('wallet_balance', { description: 'Wallet balance' }, async () => {
    try { return result({ satoshis: localBalance().toString() }) } catch (e) { return errorResult(e) }
  })
  server.registerTool('wallet_utxos', {
    description: 'List wallet UTXOs',
    inputSchema: { limit: z.number().int().positive().max(1000).optional() },
  }, async ({ limit }) => {
    try {
      const rows = listUtxos({ limit })
      return result(rows.map((u) => ({ ...u, satoshis: u.satoshis.toString() })))
    } catch (e) { return errorResult(e) }
  })
  server.registerTool('wallet_send', {
    description: 'Send BSV using P2PKH',
    inputSchema: { toAddress: z.string(), satoshis: z.union([z.number(), z.string()]), broadcast: z.boolean().default(true) },
  }, async ({ toAddress, satoshis, broadcast }) => {
    try {
      const amount = BigInt(satoshis)
      const utxos = await sourceUtxos(walletAddress())
      const selected = selectFunding(utxos, amount)
      const built = buildP2pkhSend({
        utxos: selected, wif: config.walletWif, outputs: [{ pkh: addressToPkh(toAddress), satoshis: amount }],
        changePkh: walletPkh(), feePerKb: config.feePerKb,
      })
      const arc = broadcast ? await arcSubmit(built.efHex) : null
      if (broadcast) recordBroadcast(built, selected)
      return result({ txid: built.txid, rawHex: built.rawHex, arc })
    } catch (e) { return errorResult(e) }
  })
  server.registerTool('wallet_split', {
    description: 'Split one wallet UTXO into many P2PKH outputs',
    inputSchema: { count: z.number().int().positive().max(100000), satoshisEach: z.union([z.number(), z.string()]), broadcast: z.boolean().default(true) },
  }, async ({ count, satoshisEach, broadcast }) => {
    try {
      const each = BigInt(satoshisEach)
      const rows = await sourceUtxos(walletAddress())
      const inputs = selectFunding(rows, each * BigInt(count))
      const built = buildSplitTx({ utxos: inputs, wif: config.walletWif, count, satoshisEach: each, feePerKb: config.feePerKb })
      const arc = broadcast ? await arcSubmit(built.efHex) : null
      if (broadcast) recordBroadcast(built, inputs)
      return result({ txid: built.txid, rawHex: built.rawHex, arc })
    } catch (e) { return errorResult(e) }
  })
  server.registerTool('stas_issue', {
    description: 'Issue STAS 3.0 DSTAS outputs using the official SDK',
    inputSchema: {
      amount: z.union([z.number(), z.string()]), count: z.number().int().positive().max(DSTAS_MAX_DESTINATIONS_PER_TX).default(1),
      tokenName: z.string().optional(),
      broadcast: z.boolean().default(true),
    },
  }, async ({ amount, count, tokenName, broadcast }) => {
    try {
      const value = BigInt(amount)
      const rows = await sourceUtxos(walletAddress())
      const feeReserve = BigInt(Math.max(1_000, count * Math.max(1, config.feePerKb) * 2))
      const needed = value * BigInt(count) + feeReserve
      const funding = rows.find((u) => u.kind === 'p2pkh' && u.satoshis >= needed)
      if (!funding) throw new Error('DSTAS issue requires one P2PKH UTXO covering the full issue; consolidate funding first')
      const built = buildDstasIssue({
        fundingUtxos: [funding], wif: config.walletWif, count, satoshisEach: value,
        tokenName, feePerKb: config.feePerKb,
      })
      let contractArc = null
      let arc = null
      if (broadcast) {
        contractArc = await arcSubmit(built.contractEfHex!)
        recordBroadcast({ ...built, txid: built.contractTxid!, rawHex: built.contractRawHex!, efHex: built.contractEfHex!, tx: built.contractTx! }, [funding])
        arc = await arcSubmit(built.efHex)
        recordBroadcast(built, [])
      }
      return result({ txid: built.txid, contractTxid: built.contractTxid, rawHex: built.rawHex, contractRawHex: built.contractRawHex, contractArc, arc })
    } catch (e) { return errorResult(e) }
  })
  server.registerTool('stas_transfer', {
    description: 'Transfer a STAS token UTXO',
    inputSchema: {
      tokenTxid: z.string().length(64), tokenVout: z.number().int().nonnegative(), toAddress: z.string(),
      amount: z.union([z.number(), z.string()]).optional(), broadcast: z.boolean().default(true),
    },
  }, async ({ tokenTxid, tokenVout, toAddress, amount, broadcast }) => {
    try {
      const token = listUtxos({ kind: 'stas', unspentOnly: true }).find((u) => u.txid === tokenTxid && u.vout === tokenVout)
      if (!token) throw new Error(`local token UTXO not found: ${tokenTxid}:${tokenVout}`)
      if (amount !== undefined && BigInt(amount) !== token.satoshis) throw new Error('DSTAS transfer currently transfers the full token UTXO')
      const funding = listUtxos({ kind: 'p2pkh', minSatoshis: 10n }).find((u) => u.txid !== tokenTxid)
      if (!funding) throw new Error('not enough P2PKH fee UTXOs for DSTAS transfer')
      const built = buildDstasTransfer({
        stasUtxo: token, feeUtxo: funding, wif: config.walletWif,
        to: toAddress, feePerKb: config.feePerKb,
      })
      const arc = broadcast ? await arcSubmit(built.efHex) : null
      if (broadcast) recordBroadcast(built, [token, funding])
      return result({ txid: built.txid, rawHex: built.rawHex, arc })
    } catch (e) { return errorResult(e) }
  })
  server.registerTool('wallet_import_tx', {
    description: 'Import a raw or EF transaction into the local wallet store',
    inputSchema: { hex: z.string().min(2) },
  }, async ({ hex }) => {
    try { return result(importTx(hex)) } catch (e) { return errorResult(e) }
  })
  server.registerTool('wallet_sync', { description: 'Best-effort WoC wallet synchronization' }, async () => {
    try {
      const rows = await getUtxos(walletAddress())
      let imported = 0
      for (const row of rows) {
        const importedTx = importTx(await getRawTx(row.txid))
        imported += importedTx.added
      }
      return result({ synced: true, transactions: rows.length, imported })
    } catch (e) {
      return result({ synced: false, reason: (e as Error).message })
    }
  })
  server.registerTool('tps_bench', {
    description: 'Build and optionally broadcast independent wallet transfers',
    inputSchema: {
      count: z.number().int().positive().max(100000), mode: z.enum(['p2pkh', 'stas']).default('p2pkh'),
      concurrency: z.number().int().positive().max(256).default(32), batchSize: z.number().int().positive().max(1000).default(100),
      broadcast: z.boolean().default(true), satoshisEach: z.union([z.number(), z.string()]).default(1000),
      workers: z.number().int().positive().max(256).optional(), pipeline: z.boolean().default(false),
      verifySample: z.boolean().default(true),
    },
  }, async ({ count, mode, concurrency, batchSize, broadcast, satoshisEach, workers, pipeline, verifySample }) => {
    try {
      const each = BigInt(satoshisEach)
      const rows = await sourceUtxos(walletAddress())
      const candidates = mode === 'stas'
        ? rows.filter((u) => u.kind === 'stas' && u.satoshis >= each)
        : rows.filter((u) => u.satoshis >= each)
      if (candidates.length < count) throw new Error(`not enough ${mode} UTXOs; run wallet_split first`)
      const chosen = candidates.slice(0, count)
      const funding = mode === 'stas'
        ? listUtxos({ kind: 'p2pkh', minSatoshis: 10n }).filter((u) =>
          !chosen.some((c) => c.txid === u.txid && c.vout === u.vout)).slice(0, count)
        : undefined
      if (mode === 'stas' && funding!.length < count) throw new Error('not enough funding UTXOs for stas mode; run wallet_split first')
      return result(await runSendBench({
        wif: config.walletWif, utxos: chosen, fundingUtxos: funding, mode, toPkh: walletPkh(),
        feePerKb: config.feePerKb, concurrency, broadcast, batchSize, satoshisEach: each, workers, pipeline, verifySample,
      }))
    } catch (e) { return errorResult(e) }
  })
  server.registerTool('tx_status', {
    description: 'Get ARC transaction status',
    inputSchema: { txid: z.string().length(64) },
  }, async ({ txid }) => {
    try { return result(await arcStatus(txid)) } catch (e) { return errorResult(e) }
  })
  return server
}

export const handleMcpRequest = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: unknown): Promise<void> => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  const server = createMcpServer()
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}

export const runStdio = async (): Promise<void> => {
  const server = createMcpServer()
  await server.connect(new StdioServerTransport())
}

if (process.argv[1] && /mcp[\\/]+server\.(?:ts|js)$/.test(process.argv[1])) void runStdio()

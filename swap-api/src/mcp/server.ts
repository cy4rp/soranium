import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { PrivateKey } from '@bsv/sdk'
import { z } from 'zod'
import { arcStatus, arcSubmit } from '../arc.js'
import { config } from '../config.js'
import { bytesToHex } from '../bytes.js'
import { pkhOfKey, pkhToTestnetAddress, addressToPkh } from '../keys.js'
import { getBalance, getChainInfo, getUtxos, utxoWithSource } from '../wallet/chain.js'
import { buildP2pkhSend, buildSplitTx, buildStasIssueTx, buildStasTransferTx } from '../wallet/transfer.js'
import { runSendBench } from '../wallet/sendbench.js'
import type { Utxo } from '../stas/swap.js'
import { parseStasScript } from '../stas/script.js'

const walletKey = (): PrivateKey => {
  if (!config.walletWif) throw new Error('WALLET_WIF is not configured')
  return PrivateKey.fromWif(config.walletWif)
}
const walletPkh = (): Uint8Array => pkhOfKey(walletKey())
const walletAddress = (): string => pkhToTestnetAddress(walletPkh())
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
const errorResult = (error: unknown) => result({ error: (error as Error).message })

const sourceUtxos = async (address: string, limit?: number): Promise<Utxo[]> => {
  const rows = await getUtxos(address, limit)
  return Promise.all(rows.map((u) => utxoWithSource(u.txid, u.vout)))
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
        fetch(`${config.arcUrl}/v1/policy`).then((r) => r.json()),
        getChainInfo(),
      ])
      return result({ network: config.network, arcUrl: config.arcUrl, health, policy, chain })
    } catch (e) { return errorResult(e) }
  })
  server.registerTool('wallet_info', { description: 'Wallet address and public key hash' }, async () =>
    result({ address: walletAddress(), pkh: bytesToHex(walletPkh()) }))
  server.registerTool('wallet_balance', { description: 'Wallet balance' }, async () => {
    try { return result(await getBalance(walletAddress())) } catch (e) { return errorResult(e) }
  })
  server.registerTool('wallet_utxos', {
    description: 'List wallet UTXOs',
    inputSchema: { limit: z.number().int().positive().max(1000).optional() },
  }, async ({ limit }) => {
    try {
      const rows = await getUtxos(walletAddress(), limit)
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
      return result({ txid: built.txid, rawHex: built.rawHex, arc: broadcast ? await arcSubmit(built.efHex) : null })
    } catch (e) { return errorResult(e) }
  })
  server.registerTool('wallet_split', {
    description: 'Split one wallet UTXO into many P2PKH outputs',
    inputSchema: { count: z.number().int().positive().max(100000), satoshisEach: z.union([z.number(), z.string()]), broadcast: z.boolean().default(true) },
  }, async ({ count, satoshisEach, broadcast }) => {
    try {
      const each = BigInt(satoshisEach)
      const rows = await sourceUtxos(walletAddress())
      const input = selectFunding(rows, each * BigInt(count))[0]
      const built = buildSplitTx({ utxo: input, wif: config.walletWif, count, satoshisEach: each, feePerKb: config.feePerKb })
      return result({ txid: built.txid, rawHex: built.rawHex, arc: broadcast ? await arcSubmit(built.efHex) : null })
    } catch (e) { return errorResult(e) }
  })
  server.registerTool('stas_issue', {
    description: 'Issue a synthetic or template STAS output',
    inputSchema: { amount: z.union([z.number(), z.string()]), toAddress: z.string().optional(), engine: z.enum(['synthetic', 'template']).default('synthetic') },
  }, async ({ amount, toAddress, engine }) => {
    try {
      const value = BigInt(amount)
      const rows = await sourceUtxos(walletAddress())
      const input = selectFunding(rows, value)[0]
      const built = buildStasIssueTx({
        fundingUtxo: input, wif: config.walletWif, toPkh: toAddress ? addressToPkh(toAddress) : walletPkh(),
        amount: value, engine,
      })
      return result({ txid: built.txid, rawHex: built.rawHex })
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
      const token = await utxoWithSource(tokenTxid, tokenVout)
      const rows = await sourceUtxos(walletAddress())
      const funding = selectFunding(rows.filter((u) => u.txid !== tokenTxid), 1n)[0]
      const built = buildStasTransferTx({
        tokenUtxo: token, ownerWif: config.walletWif, fundingUtxo: funding, fundingWif: config.walletWif,
        toPkh: addressToPkh(toAddress), amount: amount === undefined ? undefined : BigInt(amount), feePerKb: config.feePerKb,
      })
      return result({ txid: built.txid, rawHex: built.rawHex, arc: broadcast ? await arcSubmit(built.efHex) : null })
    } catch (e) { return errorResult(e) }
  })
  server.registerTool('tps_bench', {
    description: 'Build and optionally broadcast independent wallet transfers',
    inputSchema: {
      count: z.number().int().positive().max(100000), mode: z.enum(['p2pkh', 'stas']).default('p2pkh'),
      concurrency: z.number().int().positive().max(256).default(32), batchSize: z.number().int().positive().max(1000).default(100),
      broadcast: z.boolean().default(true), satoshisEach: z.union([z.number(), z.string()]).default(1000),
    },
  }, async ({ count, mode, concurrency, batchSize, broadcast, satoshisEach }) => {
    try {
      const each = BigInt(satoshisEach)
      const rows = await sourceUtxos(walletAddress())
      const candidates = mode === 'stas'
        ? rows.filter((u) => { try { parseStasScript(u.script); return u.satoshis >= each } catch { return false } })
        : rows.filter((u) => u.satoshis >= each)
      if (candidates.length < count) throw new Error(`not enough ${mode} UTXOs; run wallet_split first`)
      const chosen = candidates.slice(0, count)
      const funding = mode === 'stas'
        ? rows.filter((u) => !chosen.some((c) => c.txid === u.txid && c.vout === u.vout) && u.satoshis >= config.feePerKb).slice(0, count)
        : undefined
      if (mode === 'stas' && funding!.length < count) throw new Error('not enough funding UTXOs for stas mode; run wallet_split first')
      return result(await runSendBench({
        wif: config.walletWif, utxos: chosen, fundingUtxos: funding, mode, toPkh: walletPkh(),
        feePerKb: config.feePerKb, concurrency, broadcast, batchSize, satoshisEach: each,
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

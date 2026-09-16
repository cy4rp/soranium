import 'dotenv/config'

const network = (process.env.NETWORK ?? 'testnet') as 'mainnet' | 'testnet' | 'ttn'
const ttn = network === 'ttn'

export const config = {
  /** ARC endpoint of your own BSV testnet node deployment, e.g. http://localhost:9090 */
  arcUrl: process.env.ARC_URL ?? (ttn ? 'https://arcade-v2-ttn-us-1.bsvblockchain.tech' : 'http://localhost:9090'),
  arcFlavor: process.env.ARC_FLAVOR ?? (ttn ? 'arcade' : 'arc'),
  /** WhatsOnChain-compatible indexer endpoint. */
  wocUrl: process.env.WOC_URL ?? (ttn ? 'https://api.woc-ttn.bsvblockchain.tech/v1/bsv/test' : 'https://api.whatsonchain.com/v1/bsv/test'),
  /** Optional Bearer token if your ARC deployment requires auth */
  arcApiKey: process.env.ARC_API_KEY ?? '',
  /** ARC X-WaitFor status (RECEIVED | STORED | ANNOUNCED_TO_NETWORK | SEEN_ON_NETWORK) */
  arcWaitFor: process.env.ARC_WAIT_FOR ?? 'SEEN_ON_NETWORK',
  /** Optional ARC callback URL for merkle proof / status callbacks */
  arcCallbackUrl: process.env.ARC_CALLBACK_URL ?? '',
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.WALLET_DB_PATH ?? process.env.DB_PATH ?? './orderbook.sqlite',
  /** sat/kB. Testnet nodes generally accept 1 sat/kB; keep margin by default. */
  feePerKb: Number(process.env.FEE_PER_KB ?? (ttn ? 1 : 50)),
  network,
  /** Wallet WIF, intentionally never returned by API/MCP responses. */
  walletWif: process.env.WALLET_WIF ?? '',
}

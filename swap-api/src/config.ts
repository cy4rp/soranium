import 'dotenv/config'

export const config = {
  /** ARC endpoint of your own BSV testnet node deployment, e.g. http://localhost:9090 */
  arcUrl: process.env.ARC_URL ?? 'http://localhost:9090',
  /** Optional Bearer token if your ARC deployment requires auth */
  arcApiKey: process.env.ARC_API_KEY ?? '',
  /** ARC X-WaitFor status (RECEIVED | STORED | ANNOUNCED_TO_NETWORK | SEEN_ON_NETWORK) */
  arcWaitFor: process.env.ARC_WAIT_FOR ?? 'SEEN_ON_NETWORK',
  /** Optional ARC callback URL for merkle proof / status callbacks */
  arcCallbackUrl: process.env.ARC_CALLBACK_URL ?? '',
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? './orderbook.sqlite',
  /** sat/kB. Testnet nodes generally accept 1 sat/kB; keep margin by default. */
  feePerKb: Number(process.env.FEE_PER_KB ?? 50),
  network: (process.env.NETWORK ?? 'testnet') as 'mainnet' | 'testnet',
}

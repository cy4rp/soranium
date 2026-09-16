import { DatabaseSync } from 'node:sqlite'
import { config } from '../config.js'
import { bytesToHex, eq, hexToBytes } from '../bytes.js'
import { keyMaterialFromWif } from '../keys.js'
import { parseStasScript, p2pkh } from '../stas/script.js'
import type { BuiltTx } from '../stas/swap.js'
import type { Utxo } from '../stas/swap.js'
import { efToRaw, parseTx, parseTxModel } from '../tx.js'

export type WalletUtxoKind = 'p2pkh' | 'stas'
export interface WalletStoreUtxo extends Utxo {
  kind: WalletUtxoKind
  spentBy?: string | null
}
export interface SpendInput { txid: string; vout: number }

const db = new DatabaseSync(config.dbPath)
db.exec(`
  CREATE TABLE IF NOT EXISTS wallet_txs (
    txid TEXT PRIMARY KEY,
    raw_hex TEXT NOT NULL,
    ef_hex TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wallet_utxos (
    txid TEXT NOT NULL,
    vout INTEGER NOT NULL,
    satoshis INTEGER NOT NULL,
    script TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('p2pkh', 'stas')),
    spent_by TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (txid, vout)
  );
  CREATE INDEX IF NOT EXISTS idx_wallet_utxos_unspent ON wallet_utxos(spent_by, kind);
`)

const walletPkh = (): Uint8Array => keyMaterialFromWif(config.walletWif).pkh
const sourceCache = new Map<string, string>()

const rowToUtxo = (row: Record<string, unknown>): WalletStoreUtxo => ({
  txid: String(row.txid),
  vout: Number(row.vout),
  satoshis: BigInt(String(row.satoshis)),
  script: String(row.script),
  sourceTxHex: String(row.raw_hex),
  kind: String(row.kind) as WalletUtxoKind,
  spentBy: row.spent_by == null ? null : String(row.spent_by),
})

export const importTx = (hex: string): { txid: string; added: number } => {
  const normalized = hex.trim().toLowerCase()
  const isEf = normalized.length >= 20 && normalized.slice(8, 20) === '0000000000ef'
  const rawHex = isEf ? efToRaw(normalized) : normalized
  const parsed = parseTx(rawHex)
  const model = parseTxModel(rawHex)
  const now = Date.now()
  const pkh = walletPkh()
  const p2pkhScript = p2pkh(pkh)
  let added = 0
  db.exec('BEGIN')
  try {
    db.prepare(`INSERT INTO wallet_txs (txid, raw_hex, ef_hex, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(txid) DO UPDATE SET raw_hex = excluded.raw_hex, ef_hex = COALESCE(excluded.ef_hex, wallet_txs.ef_hex)`)
      .run(parsed.txid, rawHex, isEf ? normalized : null, now)
    const spend = db.prepare('UPDATE wallet_utxos SET spent_by = ? WHERE txid = ? AND vout = ? AND spent_by IS NULL')
    for (const input of model.inputs) spend.run(parsed.txid, input.txid, input.vout)
    const insert = db.prepare(`INSERT OR IGNORE INTO wallet_utxos
      (txid, vout, satoshis, script, kind, spent_by, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`)
    for (let vout = 0; vout < parsed.outputs.length; vout++) {
      const output = parsed.outputs[vout]
      let kind: WalletUtxoKind | undefined
      if (eq(output.script, p2pkhScript)) kind = 'p2pkh'
      else {
        try {
          const stas = parseStasScript(output.script)
          if (eq(stas.owner, pkh)) kind = 'stas'
        } catch { /* non-STAS output */ }
      }
      if (!kind) continue
      const result = insert.run(parsed.txid, vout, output.satoshis.toString(), bytesToHex(output.script), kind, now)
      added += Number(result.changes)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { txid: parsed.txid, added }
}

export const markSpent = (inputs: SpendInput[], spendingTxid: string): void => {
  const stmt = db.prepare('UPDATE wallet_utxos SET spent_by = ? WHERE txid = ? AND vout = ? AND spent_by IS NULL')
  db.exec('BEGIN')
  try {
    for (const input of inputs) stmt.run(spendingTxid, input.txid, input.vout)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export const listUtxos = (opts: {
  kind?: WalletUtxoKind
  minSatoshis?: bigint
  limit?: number
  unspentOnly?: boolean
} = {}): WalletStoreUtxo[] => {
  const where: string[] = []
  const args: (string | number)[] = []
  if (opts.unspentOnly !== false) where.push('u.spent_by IS NULL')
  if (opts.kind) { where.push('u.kind = ?'); args.push(opts.kind) }
  if (opts.minSatoshis !== undefined) { where.push('u.satoshis >= ?'); args.push(opts.minSatoshis.toString()) }
  const limit = opts.limit === undefined ? '' : ` LIMIT ${Math.max(0, Math.trunc(opts.limit))}`
  const sql = `SELECT u.* FROM wallet_utxos u
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY u.created_at, u.txid, u.vout${limit}`
  const source = db.prepare('SELECT raw_hex FROM wallet_txs WHERE txid = ?')
  return db.prepare(sql).all(...args).map((row) => {
    const record = row as unknown as Record<string, unknown>
    const txid = String(record.txid)
    let rawHex = sourceCache.get(txid)
    if (!rawHex) {
      const found = source.get(txid) as unknown as { raw_hex: string } | undefined
      if (!found) throw new Error(`wallet source transaction missing: ${txid}`)
      rawHex = found.raw_hex
      sourceCache.set(txid, rawHex)
    }
    return rowToUtxo({ ...record, raw_hex: rawHex })
  })
}

export const balance = (): bigint => {
  const row = db.prepare('SELECT COALESCE(SUM(satoshis), 0) AS total FROM wallet_utxos WHERE spent_by IS NULL').get() as unknown as { total: number | string | bigint }
  return BigInt(String(row.total))
}

export const recordBroadcast = (built: BuiltTx, _inputs: SpendInput[]): { txid: string; added: number } =>
  importTx(built.rawHex)

export const clearWalletStore = (): void => {
  db.exec('DELETE FROM wallet_utxos; DELETE FROM wallet_txs;')
}

export const removeTx = (txid: string): void => {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM wallet_utxos WHERE txid = ?').run(txid)
    db.prepare('DELETE FROM wallet_txs WHERE txid = ?').run(txid)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

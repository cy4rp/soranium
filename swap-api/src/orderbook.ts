/** Order book persistence over node:sqlite (Node ≥ 22). */
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'

export interface OfferRow {
  id: string
  txid: string
  vout: number
  satoshis: string // token units as decimal string (bigint-safe)
  script: string // locking script hex of the swap UTXO
  source_tx: string // raw hex of the tx holding the swap UTXO
  requested_hash: string
  receive_addr: string
  rate_num: number
  rate_den: number
  status: 'open' | 'filled' | 'cancelled'
  parent_id: string | null
  created_at: string
  updated_at: string
}

const db = new DatabaseSync(config.dbPath)
db.exec(`
  CREATE TABLE IF NOT EXISTS offers (
    id TEXT PRIMARY KEY,
    txid TEXT NOT NULL,
    vout INTEGER NOT NULL,
    satoshis TEXT NOT NULL,
    script TEXT NOT NULL,
    source_tx TEXT NOT NULL,
    requested_hash TEXT NOT NULL,
    receive_addr TEXT NOT NULL,
    rate_num INTEGER NOT NULL,
    rate_den INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    parent_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_offers_outpoint ON offers(txid, vout);
`)

export const insertOffer = (o: Omit<OfferRow, 'id' | 'created_at' | 'updated_at' | 'status' | 'parent_id'> & { status?: OfferRow['status']; parent_id?: string | null }): OfferRow => {
  const now = new Date().toISOString()
  const row: OfferRow = { ...o, parent_id: o.parent_id ?? null, id: randomUUID(), status: o.status ?? 'open', created_at: now, updated_at: now }
  db.prepare(`INSERT INTO offers (id, txid, vout, satoshis, script, source_tx, requested_hash, receive_addr, rate_num, rate_den, status, parent_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.txid, row.vout, row.satoshis, row.script, row.source_tx, row.requested_hash, row.receive_addr, row.rate_num, row.rate_den, row.status, row.parent_id, row.created_at, row.updated_at)
  return row
}

export const listOffers = (status?: string): OfferRow[] => {
  const sql = status ? `SELECT * FROM offers WHERE status = ? ORDER BY created_at DESC` : `SELECT * FROM offers ORDER BY created_at DESC`
  const stmt = db.prepare(sql)
  return (status ? stmt.all(status) : stmt.all()) as unknown as OfferRow[]
}

export const getOffer = (id: string): OfferRow | undefined =>
  db.prepare(`SELECT * FROM offers WHERE id = ?`).get(id) as unknown as OfferRow | undefined

export const setOfferStatus = (id: string, status: OfferRow['status']): void => {
  db.prepare(`UPDATE offers SET status = ?, updated_at = ? WHERE id = ?`).run(status, new Date().toISOString(), id)
}

/**
 * STAS 3.0 locking-script parsing & rebuilding.
 *
 * Layout (spec v0.2.1):
 *   [var1: push of 20-byte owner PKH/MPKH]
 *   [var2: single push of action data — any push encoding incl. OP_0/OP_2/OP_1..16/OP_1NEGATE]
 *   [engine ... OP_RETURN protoID flags serviceFields issuerPayload]
 *
 * Everything after var2 is byte-identical across every spend of an issuance,
 * so swap descriptors reference SHA256(engine + trailing region).
 */
import { createHash } from 'node:crypto'
const sha256 = (b: Uint8Array): Uint8Array => createHash('sha256').update(b).digest()
import { OP } from './constants.js'
import { bytesToHex, concat, hexToBytes } from '../bytes.js'

export interface PushRead {
  /** decoded data the push places on stack */
  data: Uint8Array
  /** raw bytes of the push as it appears in the script (opcode + payload) */
  raw: Uint8Array
  /** offset just past the push */
  next: number
}

/** Read one push at `offset`, handling every encoding variant the spec lists. */
export const readPush = (s: Uint8Array, offset: number): PushRead => {
  const op = s[offset]
  if (op === undefined) throw new Error('push read past end')
  const slice = (start: number, len: number) => {
    if (start + len > s.length) throw new Error('push payload past end')
    return s.subarray(start, start + len)
  }
  if (op === 0x00) return { data: new Uint8Array(0), raw: s.subarray(offset, offset + 1), next: offset + 1 }
  if (op >= 0x01 && op <= 0x4b) {
    const data = slice(offset + 1, op)
    return { data, raw: s.subarray(offset, offset + 1 + op), next: offset + 1 + op }
  }
  if (op === OP.PUSHDATA1) {
    const len = s[offset + 1]
    const data = slice(offset + 2, len)
    return { data, raw: s.subarray(offset, offset + 2 + len), next: offset + 2 + len }
  }
  if (op === OP.PUSHDATA2) {
    const len = s[offset + 1] | (s[offset + 2] << 8)
    const data = slice(offset + 3, len)
    return { data, raw: s.subarray(offset, offset + 3 + len), next: offset + 3 + len }
  }
  if (op === OP.PUSHDATA4) {
    const len = s[offset + 1] | (s[offset + 2] << 8) | (s[offset + 3] << 16) | (s[offset + 4] << 24)
    const data = slice(offset + 5, len >>> 0)
    return { data, raw: s.subarray(offset, offset + 5 + len), next: offset + 5 + len }
  }
  if (op === OP.ONE_NEGATE) return { data: new Uint8Array([0x81]), raw: s.subarray(offset, offset + 1), next: offset + 1 }
  if (op >= OP.ONE && op <= OP.SIXTEEN) {
    return { data: new Uint8Array([op - 0x50]), raw: s.subarray(offset, offset + 1), next: offset + 1 }
  }
  throw new Error(`expected push opcode, got 0x${op.toString(16)} at ${offset}`)
}

/** Minimal push encoding of arbitrary data (Bitcoin Script consensus-minimal). */
export const minimalPush = (data: Uint8Array): Uint8Array => {
  if (data.length === 0) return new Uint8Array([0x00])
  if (data.length === 1) {
    if (data[0] >= 1 && data[0] <= 16) return new Uint8Array([0x50 + data[0]])
    if (data[0] === 0x81) return new Uint8Array([OP.ONE_NEGATE])
  }
  if (data.length <= 0x4b) return concat(new Uint8Array([data.length]), data)
  if (data.length <= 0xff) return concat(new Uint8Array([OP.PUSHDATA1, data.length]), data)
  if (data.length <= 0xffff) return concat(new Uint8Array([OP.PUSHDATA2, data.length & 0xff, data.length >> 8]), data)
  return concat(
    new Uint8Array([OP.PUSHDATA4, data.length & 0xff, (data.length >> 8) & 0xff, (data.length >> 16) & 0xff, (data.length >>> 24) & 0xff]),
    data,
  )
}

export interface StasScript {
  /** 20-byte owner PKH / MPKH (var1) */
  owner: Uint8Array
  /** decoded var2 data (action byte + payload; empty for plain transfer) */
  var2: Uint8Array
  /** raw var2 push bytes as serialized in the script */
  var2Raw: Uint8Array
  /** engine + post-OP_RETURN region — the spend-invariant tail */
  tail: Uint8Array
  /** SHA256 (single) of `tail`; the swap descriptor's requestedScriptHash */
  persistentHash: Uint8Array
  /** 20-byte protoID (token identity), if locatable after OP_RETURN */
  protoId?: Uint8Array
}

/** Parse a STAS 3.0 locking script. Throws if the leading shape doesn't match. */
export const parseStasScript = (script: Uint8Array | string): StasScript => {
  const s = typeof script === 'string' ? hexToBytes(script) : script
  const v1 = readPush(s, 0)
  if (v1.data.length !== 20) throw new Error('var1 is not a 20-byte owner hash — not a STAS locking script?')
  const v2 = readPush(s, v1.next)
  const tail = s.subarray(v2.next)
  if (tail.length < 32) throw new Error('script tail too short — not a STAS locking script?')
  const persistentHash = sha256(tail)
  return {
    owner: v1.data,
    var2: v2.data,
    var2Raw: v2.raw,
    tail,
    persistentHash,
    protoId: findProtoId(tail),
  }
}

/** Best-effort protoID extraction: the 20-byte push immediately after the engine's final OP_RETURN. */
const findProtoId = (tail: Uint8Array): Uint8Array | undefined => {
  // The engine contains no OP_RETURN before its terminal one, so scan from the end
  // of the opcode region: find the last 0x6a followed by a 20-byte push.
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x6a && tail[i + 1] === 0x14) {
      try { return readPush(tail, i + 1).data } catch { /* keep scanning */ }
    }
  }
  return undefined
}

/** Rebuild a STAS locking script with a new owner and var2 value over the same tail. */
export const buildStasScript = (owner: Uint8Array, var2: Uint8Array, tail: Uint8Array): Uint8Array => {
  if (owner.length !== 20) throw new Error('owner must be 20 bytes')
  return concat(minimalPush(owner), minimalPush(var2), tail)
}

/** Standard P2PKH locking script. */
export const p2pkh = (pkh: Uint8Array): Uint8Array =>
  concat(new Uint8Array([OP.DUP, OP.HASH160]), minimalPush(pkh), new Uint8Array([OP.EQUALVERIFY, OP.CHECKSIG]))

export const scriptHex = bytesToHex

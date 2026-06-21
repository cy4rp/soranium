/**
 * Fast ECDSA signing via @noble/secp256k1 (≈7× faster than @bsv/sdk's pure-BN
 * implementation). Produces canonical low-S DER signatures identical in form
 * to the consensus-accepted encoding.
 */
import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { PrivateKey } from '@bsv/sdk'
import { concat } from './bytes.js'

// noble v3 requires explicit hash wiring (no built-in sync hashes)
secp.hashes.hmacSha256 = (key: Uint8Array, msg: Uint8Array) => hmac(sha256, key, msg)
secp.hashes.sha256 = sha256

// Prefer native libsecp256k1 bindings (~11× faster); fall back to noble (pure JS)
// when the native module is unavailable on the host.
type NativeSecp = {
  ecdsaSign: (msg: Uint8Array, priv: Uint8Array) => { signature: Uint8Array }
  publicKeyCreate: (priv: Uint8Array, compressed: boolean) => Uint8Array
}
let native: NativeSecp | null = null
try {
  const mod = await import('secp256k1')
  native = (mod.default ?? mod) as unknown as NativeSecp
} catch { /* pure-JS fallback */ }

export const signerBackend = (): string => (native ? 'libsecp256k1 (native)' : '@noble/secp256k1 (JS)')

/** Strip leading zeros, then re-pad one 0x00 if the MSB is set (DER integer rule). */
const derInt = (b: Uint8Array): Uint8Array => {
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  const v = b.subarray(i)
  return v[0] & 0x80 ? concat(new Uint8Array([0]), v) : v
}

/** compact (r‖s, 64 bytes) → DER */
export const compactToDer = (sig: Uint8Array): Uint8Array => {
  const r = derInt(sig.subarray(0, 32))
  const s = derInt(sig.subarray(32, 64))
  return concat(
    new Uint8Array([0x30, 4 + r.length + s.length, 0x02, r.length]), r,
    new Uint8Array([0x02, s.length]), s,
  )
}

export const privBytes = (key: PrivateKey): Uint8Array =>
  Uint8Array.from(key.toArray() as number[])

/** Sign a 32-byte digest → DER ‖ sighashByte. Both backends emit low-S. */
export const fastSignDigest = (digest: Uint8Array, priv: Uint8Array, sighashType: number): Uint8Array => {
  const compact = native
    ? native.ecdsaSign(digest, priv).signature
    : (secp.sign(digest, priv, { prehash: false }) as Uint8Array)
  return concat(compactToDer(compact), new Uint8Array([sighashType & 0xff]))
}

export const fastPubKey = (priv: Uint8Array): Uint8Array =>
  native ? Uint8Array.from(native.publicKeyCreate(priv, true)) : secp.getPublicKey(priv, true)

import { createHash } from 'node:crypto'
const nodeSha256 = (b: Uint8Array): Uint8Array => createHash('sha256').update(b).digest()
export const sha256dFast = (b: Uint8Array): Uint8Array => nodeSha256(nodeSha256(b))

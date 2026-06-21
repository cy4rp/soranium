import { PrivateKey, Utils } from '@bsv/sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { fastPubKey, privBytes } from './fastsign.js'
import { bytesToHex } from './bytes.js'

export const privFromWif = (wif: string): PrivateKey => PrivateKey.fromWif(wif)

export const hash160 = (b: Uint8Array): Uint8Array => ripemd160(sha256(b))

/** WIF → cached {priv bytes, compressed pubkey, pkh}. One EC mult per WIF, ever. */
export interface KeyMaterial { priv: Uint8Array; pub: Uint8Array; pkh: Uint8Array }
const keyCache = new Map<string, KeyMaterial>()
export const keyMaterialFromWif = (wif: string): KeyMaterial => {
  const hit = keyCache.get(wif)
  if (hit) return hit
  const priv = privBytes(PrivateKey.fromWif(wif))
  const pub = fastPubKey(priv)
  const km = { priv, pub, pkh: hash160(pub) }
  keyCache.set(wif, km)
  return km
}

export const pubKeyBytes = (key: PrivateKey): Uint8Array => fastPubKey(privBytes(key))

export const pkhOfKey = (key: PrivateKey): Uint8Array => hash160(pubKeyBytes(key))

/** Decode a base58check address (mainnet/testnet) to its 20-byte hash. */
export const addressToPkh = (address: string): Uint8Array => {
  const { data } = Utils.fromBase58Check(address)
  const bytes = Uint8Array.from(data as number[])
  if (bytes.length !== 20) throw new Error(`address decodes to ${bytes.length} bytes, expected 20`)
  return bytes
}

export const pkhToTestnetAddress = (pkh: Uint8Array): string =>
  Utils.toBase58Check(Array.from(pkh), [0x6f])

export { bytesToHex }

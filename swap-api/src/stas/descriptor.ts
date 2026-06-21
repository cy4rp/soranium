/**
 * Swap descriptor — the var2 action data for action 0x01 (spec v0.2.1 §swap).
 *
 *   [0]      0x01 action id
 *   [1..32]  SHA256 of the requested asset's spend-invariant script tail
 *   [33..52] receiveAddr (PKH / MPKH) for the requested asset
 *   [53..60] rate: u32le numerator ‖ u32le denominator
 *   [61.. ]  next var2 to install on the maker's remainder (optional;
 *            recursive form drops the leading action byte)
 */
import { ACTION } from './constants.js'
import { concat, u32le } from '../bytes.js'

export interface SwapDescriptor {
  requestedScriptHash: Uint8Array // 32 bytes
  receiveAddr: Uint8Array // 20 bytes
  rateNumerator: number // u32; 0 disables the rate check (NFT swaps)
  rateDenominator: number // u32
  /** literal next var2 bytes for the remainder UTXO (empty = plain var2) */
  next?: Uint8Array
}

export const encodeSwapDescriptor = (d: SwapDescriptor): Uint8Array => {
  if (d.requestedScriptHash.length !== 32) throw new Error('requestedScriptHash must be 32 bytes')
  if (d.receiveAddr.length !== 20) throw new Error('receiveAddr must be 20 bytes')
  return concat(
    new Uint8Array([ACTION.SWAP]),
    d.requestedScriptHash,
    d.receiveAddr,
    u32le(d.rateNumerator),
    u32le(d.rateDenominator),
    d.next ?? new Uint8Array(0),
  )
}

export const decodeSwapDescriptor = (var2: Uint8Array): SwapDescriptor => {
  if (var2.length < 61 || var2[0] !== ACTION.SWAP) throw new Error('not a swap descriptor (need ≥61 bytes, action 0x01)')
  const dv = new DataView(var2.buffer, var2.byteOffset)
  return {
    requestedScriptHash: var2.subarray(1, 33),
    receiveAddr: var2.subarray(33, 53),
    rateNumerator: dv.getUint32(53, true),
    rateDenominator: dv.getUint32(57, true),
    next: var2.length > 61 ? var2.subarray(61) : undefined,
  }
}

/**
 * Required amount of the wanted asset for taking `taken` units of the offered asset.
 * Engine rule: A' = (A × num) / den over 8-byte unsigned ints, multiplication first,
 * enforced as a lower bound on what reaches receiveAddr.
 */
export const requiredWantedAmount = (taken: bigint, num: number, den: number): bigint => {
  if (num === 0) return 0n // rate check disabled
  if (den === 0) throw new Error('rateDenominator is 0 with non-zero numerator')
  return (taken * BigInt(num)) / BigInt(den)
}

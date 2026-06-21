/** STAS 3.0 protocol constants (spec v0.2.1). */
import { hexToBytes } from '../bytes.js'

/** HASH160("") — signature-suppression / arbitrator-free owner sentinel. */
export const EMPTY_HASH160 = hexToBytes('b472a266d0bd89c13706a4132ccfb16f7c3b9fcb')

/** var2 action identifiers (first byte of pushed action data). */
export const ACTION = { PLAIN: 0x00, SWAP: 0x01, FROZEN: 0x02 } as const

/** Unlocking-script spendType parameter. */
export const SPEND_TYPE = { REGULAR: 1, FREEZE: 2, CONFISCATE: 3, CANCEL_SWAP: 4 } as const

/** Unlocking-script txType parameter. 0 = regular/split, 1 = atomic swap, 2..7 = merge variants. */
export const TX_TYPE = { REGULAR: 0, SWAP: 1 } as const

/** BSV sighash: ALL | FORKID. STAS preimages commit to all outputs. */
export const SIGHASH_ALL_FORKID = 0x41

/** Script opcodes used here. */
export const OP = {
  FALSE: 0x00, PUSHDATA1: 0x4c, PUSHDATA2: 0x4d, PUSHDATA4: 0x4e,
  ONE_NEGATE: 0x4f, RESERVED: 0x50, ONE: 0x51, TWO: 0x52, SIXTEEN: 0x60,
  RETURN: 0x6a, DUP: 0x76, HASH160: 0xa9, EQUALVERIFY: 0x88, CHECKSIG: 0xac,
} as const

/** Small byte helpers shared across the STAS modules. */

export const hexToBytes = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) throw new Error(`invalid hex length: ${hex.length}`)
  const buf = Buffer.from(hex, 'hex') // native, ~GB/s
  if (buf.length * 2 !== hex.length) throw new Error(`invalid hex: ${hex.slice(0, 32)}…`)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length)
}

export const bytesToHex = (b: Uint8Array): string =>
  Buffer.from(b.buffer, b.byteOffset, b.length).toString('hex')

export const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

export const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0, true)
  return b
}

export const u64le = (n: bigint): Uint8Array => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, n, true)
  return b
}

export const varInt = (n: number | bigint): Uint8Array => {
  const v = BigInt(n)
  if (v < 0xfdn) return new Uint8Array([Number(v)])
  if (v <= 0xffffn) return concat(new Uint8Array([0xfd]), new Uint8Array([Number(v & 0xffn), Number(v >> 8n)]))
  if (v <= 0xffffffffn) return concat(new Uint8Array([0xfe]), u32le(Number(v)))
  return concat(new Uint8Array([0xff]), u64le(v))
}

export class Reader {
  pos = 0
  constructor(public buf: Uint8Array) {}
  take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('read past end')
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  u8(): number { return this.take(1)[0] }
  u32(): number { return new DataView(this.take(4).slice().buffer).getUint32(0, true) }
  u64(): bigint { return new DataView(this.take(8).slice().buffer).getBigUint64(0, true) }
  varInt(): bigint {
    const first = this.u8()
    if (first < 0xfd) return BigInt(first)
    if (first === 0xfd) { const b = this.take(2); return BigInt(b[0] | (b[1] << 8)) }
    if (first === 0xfe) return BigInt(this.u32())
    return this.u64()
  }
}

export const eq = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

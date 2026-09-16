import { readFileSync } from 'node:fs'
import { Script } from '@bsv/sdk'
import { minimalPush } from './script.js'

const templatePath = new URL('../../assets/stas3-template.txt', import.meta.url)

const normalizedAsm = (asm: string): string => asm.split(/\s+/).map((token) =>
  token.startsWith('OP_') || token === '0' || token === '-1' ? token : token.toLowerCase()).join(' ')

const substitute = (ownerHex: string, var2Hex: string): string => readFileSync(templatePath, 'utf8').trim()
  .replace('<owner address/MPKH - 20 bytes>', ownerHex)
  .replace('<2nd variable field>', var2Hex || '0')
  .replace('<"redemption address"/"protocol ID" - 20 bytes>', ownerHex)
  .replace('<flags field>', '00')
  .replace('<service data per each flag>', '00')
  .replace('<optional data field/s - upto around 4.2GB size>', '0')

export const compileStasTemplate = (ownerPkh: Uint8Array | string, var2: Uint8Array | string): Uint8Array => {
  const ownerHex = typeof ownerPkh === 'string' ? ownerPkh : Buffer.from(ownerPkh).toString('hex')
  const var2Hex = typeof var2 === 'string' ? var2 : Buffer.from(var2).toString('hex')
  if (ownerHex.length !== 40) throw new Error('ownerPkh must be 20 bytes')
  const asm = normalizedAsm(substitute(ownerHex, var2Hex))
  return Uint8Array.from(Script.fromASM(asm).toUint8Array())
}

export const compileStasTemplateAsm = (ownerPkh: Uint8Array | string, var2: Uint8Array | string): string => {
  const ownerHex = typeof ownerPkh === 'string' ? ownerPkh : Buffer.from(ownerPkh).toString('hex')
  const var2Hex = typeof var2 === 'string' ? var2 : Buffer.from(var2).toString('hex')
  return normalizedAsm(substitute(ownerHex, var2Hex))
}

export const templatePush = (value: Uint8Array): Uint8Array => minimalPush(value)

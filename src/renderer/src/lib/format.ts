import type { Cell } from '@shared/types'

const pad = (n: number): string => String(n).padStart(2, '0')

export function formatCell(v: Cell): string {
  if (v === null) return ''
  if (v instanceof Date) {
    const d = `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
    return v.getHours() || v.getMinutes() || v.getSeconds() ? `${d} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}` : d
  }
  if (v instanceof Uint8Array) return `[binary ${v.byteLength}B]`
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

export const isNumeric = (v: Cell): boolean => typeof v === 'number' || typeof v === 'bigint'

export function compareCells(a: Cell, b: Cell): number {
  if (a === null) return b === null ? 0 : 1
  if (b === null) return -1
  if (isNumeric(a) && isNumeric(b)) return Number(a) - Number(b)
  return formatCell(a).localeCompare(formatCell(b), 'ko', { numeric: true })
}

export const plural = (n: number): string => n.toLocaleString()

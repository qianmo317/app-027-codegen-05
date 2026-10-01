import type { Pt } from '@/logic/types'

/** 画布叠加折线（版本对照用）：points 为原始 mm 坐标，按 placement 摆放 */
export type OverlayPath = {
  key: string
  points: Pt[]
  closed?: boolean
  color: string
  width?: number
  dash?: string
  opacity?: number
  emphasis?: boolean
}

export type OverlayBridge = {
  key: string
  at: Pt
  end: Pt
  color: string
  emphasis?: boolean
}

export type OverlayTravel = {
  key: string
  from: Pt
  to: Pt
  color: string
  emphasis?: boolean
  dashed?: boolean
}

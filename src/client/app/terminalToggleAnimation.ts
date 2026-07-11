export const TERMINAL_TOGGLE_ANIMATION_DURATION_MS = 350

const TAILWIND_EASE_IN_OUT: [number, number, number, number] = [0.4, 0, 0.2, 1]
const NEWTON_ITERATIONS = 8
const NEWTON_EPSILON = 1e-6

function sampleCurveX(t: number, x1: number, x2: number) {
  const inverse = 1 - t
  return 3 * inverse * inverse * t * x1 + 3 * inverse * t * t * x2 + t * t * t
}

function sampleCurveY(t: number, y1: number, y2: number) {
  const inverse = 1 - t
  return 3 * inverse * inverse * t * y1 + 3 * inverse * t * t * y2 + t * t * t
}

function sampleCurveDerivativeX(t: number, x1: number, x2: number) {
  const inverse = 1 - t
  return 3 * inverse * inverse * x1 + 6 * inverse * t * (x2 - x1) + 3 * t * t * (1 - x2)
}

function solveBezierTForX(x: number, x1: number, x2: number) {
  let t = x

  for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration += 1) {
    const currentX = sampleCurveX(t, x1, x2) - x
    if (Math.abs(currentX) < NEWTON_EPSILON) {
      return t
    }

    const derivative = sampleCurveDerivativeX(t, x1, x2)
    if (Math.abs(derivative) < NEWTON_EPSILON) {
      break
    }

    t -= currentX / derivative
  }

  return t
}

export function easeInOutCubic(progress: number) {
  if (progress <= 0) return 0
  if (progress >= 1) return 1

  const [x1, y1, x2, y2] = TAILWIND_EASE_IN_OUT
  const t = solveBezierTForX(progress, x1, x2)
  return sampleCurveY(t, y1, y2)
}

export function interpolateLayout(start: [number, number], end: [number, number], progress: number): [number, number] {
  const eased = easeInOutCubic(progress)
  return [
    start[0] + (end[0] - start[0]) * eased,
    start[1] + (end[1] - start[1]) * eased,
  ]
}

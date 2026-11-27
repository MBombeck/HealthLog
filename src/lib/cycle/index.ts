/**
 * Cycle prediction + phase engine — public surface.
 *
 * Pure, deterministic, DB-free. The iOS client re-implements this 1:1 in
 * Swift; the unit-test fixtures under
 * `__tests__/` are the shared parity contract.
 */

export * from "./types";
export * from "./day-math";
export {
  predictCycle,
  median,
  mad,
  resolveLuteal,
  clampLuteal,
} from "./prediction";
export { phaseForDay, type PhaseCycle } from "./phase";

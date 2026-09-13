export interface Bounds { min: number; max: number; coverage: "complete" | "unknown"; }

/** Unknown is never a clear certificate, even when numerical min/max happen to be finite. */
export function parentEncloses(parent: Bounds, child: Bounds): boolean {
  return parent.min <= child.min && parent.max >= child.max;
}

export function canCertifyClear(bound: Bounds): boolean { return bound.coverage === "complete"; }

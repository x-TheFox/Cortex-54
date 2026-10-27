import { z } from "zod";

/**
 * Calibration maps (config/calibration.json), produced only by Governor pull requests (constitution U8).
 * A map is a monotone piecewise-linear curve raw → calibrated fitted by isotonic regression on logged outcomes.
 */
export const CalibrationMapSchema = z.object({
  n: z.number().int().nonnegative(),
  points: z
    .array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]))
    .min(2)
    .refine(
      (p) =>
        p.every(
          (x, i) =>
            i === 0 ||
            (x[0] > (p[i - 1] as [number, number])[0] && x[1] >= (p[i - 1] as [number, number])[1]),
        ),
      {
        message: "points must be strictly increasing in x and non-decreasing in y",
      },
    ),
  brier_raw: z.number().min(0).max(1).optional(),
  brier_calibrated: z.number().min(0).max(1).optional(),
})
  // audit F-A2-03: a map may only make the court less confident above a coin flip, never more — a corrupted or
  // adversarial map can't inflate sizes toward the caps
  .refine((m) => m.points.every(([x, y]) => y <= Math.max(x, 0.5) + 1e-9), {
    message: "a calibration map may not raise a probability above max(raw, 0.5)",
  })
  // and it must not be worse than no map at all on its own holdout
  .refine((m) => m.brier_raw === undefined || m.brier_calibrated === undefined || m.brier_calibrated <= m.brier_raw, {
    message: "calibrated Brier score must not be worse than raw",
  });
export type CalibrationMap = z.infer<typeof CalibrationMapSchema>;

export const CalibrationSchema = z.object({
  $comment: z.string().optional(),
  version: z.number().int(),
  generated_at: z.number().int().nullable(),
  maps: z.record(z.string(), CalibrationMapSchema),
});
export type Calibration = z.infer<typeof CalibrationSchema>;

/** Monotone interpolation through the map; clamps outside the fitted range. Pure. */
export function applyMap(map: CalibrationMap, raw: number): number {
  const p = map.points;
  const first = p[0] as [number, number];
  const last = p[p.length - 1] as [number, number];
  if (raw <= first[0]) return first[1];
  if (raw >= last[0]) return last[1];
  for (let i = 1; i < p.length; i++) {
    const [x1, y1] = p[i] as [number, number];
    const [x0, y0] = p[i - 1] as [number, number];
    if (raw <= x1) return y0 + ((raw - x0) / (x1 - x0)) * (y1 - y0);
  }
  return last[1];
}

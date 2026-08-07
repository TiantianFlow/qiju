/**
 * Normalize raw bid text input into the amount to submit.
 *
 * Preserves the historical clamp semantics used inline in Table.tsx
 * (`Math.max(min, Math.min(max, Number(input) || 0))`) while also reporting
 * whether the value was truncated to the upper bound, so the UI can surface
 * the budget cap to the player instead of silently substituting it (THE-28).
 *
 * `wasCapped` is only about truncation at the top (budget cap). Values clamped
 * at the lower bound keep the legacy behavior and are not reported as capped.
 */
export function normalizeBidInput(
  input: string,
  min: number,
  max: number,
): { amount: number; wasCapped: boolean } {
  const parsed = Number(input) || 0;
  const amount = Math.max(min, Math.min(max, parsed));
  return { amount, wasCapped: parsed > max };
}

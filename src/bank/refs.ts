// Deterministic, so a retry of the same sweep can never create a second transfer.
export const sweepIds = (merchantId: string, sweepDate: string) => ({
  reference: `KOBO-SWP-${merchantId}-${sweepDate}`,
  idempotencyKey: `swp-${merchantId}-${sweepDate}`,
});

export const withdrawalIds = (withdrawalId: string) => ({
  reference: `KOBO-WD-${withdrawalId}`,
  idempotencyKey: `wd-${withdrawalId}`,
});

// Demo customer payments (simulated). These ARE counted as takings.
export const demoInflowIds = (n: string) => ({
  reference: `KOBO-IN-${n}`,
  idempotencyKey: `in-${n}`,
});
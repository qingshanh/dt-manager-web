export type PhoneActionBalanceEvidenceInput = {
  cachedBalance: number | null;
  requireFresh: boolean;
  refresh: () => Promise<number | null | undefined>;
  onRefreshError?: (error: unknown) => void;
};

export async function resolvePhoneActionBalanceEvidence(
  input: PhoneActionBalanceEvidenceInput
): Promise<number | null> {
  try {
    const refreshed = normalizeBalance(await input.refresh());
    if (refreshed !== null) return refreshed;
  } catch (error) {
    input.onRefreshError?.(error);
  }
  return input.requireFresh ? null : normalizeBalance(input.cachedBalance);
}

function normalizeBalance(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

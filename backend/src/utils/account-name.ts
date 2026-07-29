import { repairUtf8Mojibake } from "./serializers.js";

type AccountNameInput = {
  nickname?: string | null;
  email?: string | null;
  phone?: string | null;
  dtUserId?: string | null;
  snapshot?: { fullName?: string | null } | null;
};

export function normalizeAccountName(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized) return null;
  return repairUtf8Mojibake(normalized)?.trim() || normalized;
}

export function resolveAccountDisplayName(input: AccountNameInput, fallback = "Unnamed account") {
  return (
    normalizeAccountName(input.nickname) ??
    normalizeAccountName(input.snapshot?.fullName) ??
    normalizeAccountName(input.email) ??
    normalizeAccountName(input.phone) ??
    normalizeAccountName(input.dtUserId) ??
    fallback
  );
}

export function resolveRefreshedAccountNickname(
  currentNickname: string | null | undefined,
  snapshotName: string | null | undefined,
  account: Pick<AccountNameInput, "email" | "phone" | "dtUserId">
) {
  const currentRaw = currentNickname?.trim() || null;
  const current = normalizeAccountName(currentNickname);
  const snapshot = normalizeAccountName(snapshotName);
  const generatedNames = [account.email, account.phone, account.dtUserId]
    .map(normalizeAccountName)
    .filter((value): value is string => Boolean(value));

  if (!current) {
    return snapshot ?? resolveAccountDisplayName(account);
  }
  if (currentRaw !== current) {
    return current;
  }
  if (snapshot && generatedNames.includes(current)) {
    return snapshot;
  }
  return current;
}

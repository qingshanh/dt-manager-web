export type PhoneRenewalSessionInput<TBalance, TResult> = {
  refreshBalance: () => Promise<TBalance>;
  isBalanceConfirmed: (balance: TBalance) => boolean;
  writeOrder: () => Promise<TResult>;
};

export async function runPhoneRenewalSession<TBalance, TResult>(
  input: PhoneRenewalSessionInput<TBalance, TResult>
): Promise<TResult> {
  const balance = await input.refreshBalance();
  if (!input.isBalanceConfirmed(balance)) {
    throw new Error("Could not confirm same-session balance before renewal write");
  }
  return input.writeOrder();
}

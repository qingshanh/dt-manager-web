type AccountListStatus = "pending" | "offline" | "online" | "error" | "expired";
export type AccountListMonitorState = "running" | "retrying" | "stopped";

export function isRetryableMonitorTransportError(message: string) {
  return /(?:direct gateway )?socket (?:closed|ended|has been ended|is not writable)|timed out waiting for (?:direct push frame|connect response|queryrtcservers(?:ex)? json response)|\b(?:econnreset|econnaborted|econnrefused|etimedout)\b/i.test(
    message
  );
}

export function isAuthenticationSessionError(message: string) {
  return /user\s*id\s*not\s*match|invalid\s+(?:user|token|session)|(?:token|session)\s+(?:is\s+)?(?:invalid|expired)|authentication\s+(?:failed|failure)|unauthori[sz]ed|\b401\b/i.test(
    message
  );
}

export function resolveAccountListMonitorState(input: {
  status: AccountListStatus;
  monitorEnabled: boolean;
  lastError: string | null;
}) {
  const requiresRelogin = input.lastError !== null && isAuthenticationSessionError(input.lastError);
  const retrying = input.monitorEnabled && input.lastError !== null && isRetryableMonitorTransportError(input.lastError);
  const status = requiresRelogin
    ? "expired"
    : !input.monitorEnabled && input.status === "online"
      ? "offline"
      : retrying && input.status === "error"
        ? "online"
        : input.status;
  return {
    status,
    monitorState: input.monitorEnabled ? (retrying ? "retrying" : "running") : "stopped",
    requiresRelogin
  } as { status: AccountListStatus; monitorState: AccountListMonitorState; requiresRelogin: boolean };
}

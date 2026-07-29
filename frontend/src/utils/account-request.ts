export function getOrCreateAccountRequest<T>(
  inFlight: Map<number, Promise<T>>,
  accountId: number,
  createRequest: () => Promise<T>,
) {
  const existing = inFlight.get(accountId);
  if (existing) {
    return existing;
  }

  let request!: Promise<T>;
  request = createRequest().finally(() => {
    if (inFlight.get(accountId) === request) {
      inFlight.delete(accountId);
    }
  });
  inFlight.set(accountId, request);
  return request;
}

export function isCurrentAccountRequest(
  activeScope: { accountId: number; generation: number },
  requestScope: { accountId: number; generation: number },
  latestRequestId: number,
  requestId: number,
) {
  return activeScope.accountId === requestScope.accountId
    && activeScope.generation === requestScope.generation
    && latestRequestId === requestId;
}

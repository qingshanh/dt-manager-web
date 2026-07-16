export interface RuntimeHealthInput {
  version: string;
  gatewayMode: string;
  instanceId?: string;
  startedAt: Date;
  now?: Date;
}

export function buildHealthPayload(input: RuntimeHealthInput) {
  const now = input.now ?? new Date();
  return {
    ok: true as const,
    version: input.version,
    gatewayMode: input.gatewayMode,
    instanceId: input.instanceId || null,
    startedAt: input.startedAt.toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((now.getTime() - input.startedAt.getTime()) / 1000))
  };
}

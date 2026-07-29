export const ORDER_PRIVATE_NUMBER_NATIVE_REST_CALL_TYPE = 2050;
export const ORDER_PRIVATE_NUMBER_API_NAME = "/pstn/share/orderPrivateNumber";

const PROXY_REST_ROUTE_LENGTH = 8;
const PROXY_REST_CONTEXT_LENGTH = 8;

type OrderPrivateNumberRpcContext = {
  commandCookie?: number;
  commandTag?: number;
};

export function encodeOrderPrivateNumberRpcContext(context: OrderPrivateNumberRpcContext = {}) {
  const commandCookie = context.commandCookie ?? 0;
  const commandTag = context.commandTag ?? 0;
  assertUint32(commandCookie, "commandCookie");
  assertUint32(commandTag, "commandTag");

  const encoded = Buffer.alloc(PROXY_REST_CONTEXT_LENGTH);
  encoded.writeUInt32BE(commandCookie, 0);
  encoded.writeUInt32BE(commandTag, 4);
  return encoded;
}

export function patchProxyRestRequestContext(body: Buffer, encodedContext: Buffer) {
  if (body.length < PROXY_REST_ROUTE_LENGTH + PROXY_REST_CONTEXT_LENGTH) {
    throw new Error("ProxyRest request body must contain an eight-byte route and context");
  }
  if (encodedContext.length !== PROXY_REST_CONTEXT_LENGTH) {
    throw new Error("ProxyRest request context must be exactly 8 bytes");
  }

  const patched = Buffer.from(body);
  encodedContext.copy(patched, PROXY_REST_ROUTE_LENGTH);
  return patched;
}

function assertUint32(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer`);
  }
}

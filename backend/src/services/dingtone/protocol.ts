import zlib from "node:zlib";

export const MAGIC_HEADER = Buffer.from([0x01, 0x07]);

export type PacketType = 0x8201 | 0x8102 | 0x8107;
export type PacketStatus = 0x0101 | 0x0102 | 0x0103 | 0x0104;

export function buildConnectRequest(session = 0) {
  const buffer = Buffer.alloc(12);
  MAGIC_HEADER.copy(buffer, 0);
  buffer.writeUInt32BE(12, 2);
  buffer.writeUInt16BE(0x8201, 6);
  buffer.writeUInt32BE(session, 8);
  return buffer;
}

export function encodeEdgeHttpFrame(input: {
  session: number;
  status: PacketStatus;
  routeAddress: Buffer;
  apiPath: string;
  params: Record<string, string | number | boolean | undefined>;
  extra?: Buffer;
}) {
  const query = Object.entries(input.params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join("&");
  const compressed = zlib.deflateSync(Buffer.from(query, "utf8"));
  const binaryFields = Buffer.concat([input.routeAddress, Buffer.from(input.apiPath, "utf8"), compressed]);
  const extra = input.extra ?? Buffer.alloc(0);
  const totalLength = 2 + 4 + 2 + 4 + 4 + 2 + 4 + binaryFields.length + extra.length;
  const buffer = Buffer.alloc(totalLength);
  MAGIC_HEADER.copy(buffer, 0);
  buffer.writeUInt32BE(totalLength, 2);
  buffer.writeUInt16BE(0x8107, 6);
  buffer.writeUInt32BE(input.session, 8);
  buffer.writeUInt32BE(binaryFields.length + extra.length + 10, 12);
  buffer.writeUInt16BE(input.status, 16);
  buffer.writeUInt32BE(binaryFields.length, 18);
  binaryFields.copy(buffer, 22);
  extra.copy(buffer, 22 + binaryFields.length);
  return buffer;
}

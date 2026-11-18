// pkt-line codec for git smart HTTP: 4-hex-length framing, flush (0000), delim (0001), response-end (0002).
// Written from the git protocol facts the sealed suite's client uses; no dependency.

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktLineFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktLineDelim = (): Buffer => Buffer.from('0001', 'ascii');
export const pktLineResponseEnd = (): Buffer => Buffer.from('0002', 'ascii');

/** Encode a mixed sequence; the strings 'flush'/'delim'/'response-end' are the control packets. */
export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a complete buffer into packets (a lenient decoder: trailing bytes are ignored). */
export function decodePktLines(bytes: Uint8Array): GitPacket[] {
  const buffer = asBuffer(bytes);
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    const raw = buffer.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw });
    offset += length;
  }
  return packets;
}

/** Split a raw body into lines: the packets before the first flush, joined per packet, are the lines. */
export function packetLines(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  for (const packet of decodePktLines(bytes)) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

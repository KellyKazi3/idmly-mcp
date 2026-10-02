// Minimal zip reader: enough for the engine's converted_bundle.zip (stored or
// deflated entries, no zip64, no encryption). Avoids a dependency for one job.
// Every offset read is bounds-checked so a truncated or hostile archive fails
// with a clear error instead of an ERR_OUT_OF_RANGE, and inflation is capped
// at the declared size so a bad archive cannot balloon in memory.
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

class Corrupt extends Error {
  constructor(what: string) { super(`corrupt zip (${what})`); }
}

function u16(buf: Buffer, off: number): number {
  if (off < 0 || off + 2 > buf.length) throw new Corrupt("offset out of range");
  return buf.readUInt16LE(off);
}
function u32(buf: Buffer, off: number): number {
  if (off < 0 || off + 4 > buf.length) throw new Corrupt("offset out of range");
  return buf.readUInt32LE(off);
}

export function unzip(buf: Buffer): ZipEntry[] {
  // End of central directory record: signature 0x06054b50, scan back from the tail
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Corrupt("no end-of-central-directory record");
  const count = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16); // central directory offset
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (u32(buf, p) !== 0x02014b50) throw new Corrupt("central directory");
    const method = u16(buf, p + 10);
    const csize = u32(buf, p + 20);
    const usize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const localOff = u32(buf, p + 42);
    if (p + 46 + nameLen > buf.length) throw new Corrupt("entry name");
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // directory entry
    if (u32(buf, localOff) !== 0x04034b50) throw new Corrupt("local header");
    const lNameLen = u16(buf, localOff + 26);
    const lExtraLen = u16(buf, localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    if (start + csize > buf.length) throw new Corrupt("entry data truncated");
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);
    if (data.length !== usize) throw new Corrupt(`size mismatch unpacking ${name}`);
    out.push({ name, data });
  }
  return out;
}

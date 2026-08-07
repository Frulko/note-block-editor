/**
 * A ZIP file, stored (uncompressed), written by hand.
 *
 * @remarks
 * The vault export produces a list of paths and contents; a browser can only
 * hand the user *one* file. A ZIP is the format every operating system opens
 * with a double click, and the stored variant needs no compressor — just the
 * three record types and a CRC-32.
 *
 * A dependency would be the reflex here, and it is the wrong one for maybe
 * seventy lines: the alternative to this is shipping a compression library to
 * every visitor so that a demo can offer a download. Compression itself would
 * change that calculation — this deliberately does not compress, and a vault
 * of Markdown zipped at level 0 is still smaller than the library that would
 * compress it.
 *
 * Correctness is not taken on trust: `e2e/vault.spec.ts` downloads the archive
 * and reads it with two independent implementations — Info-ZIP's `unzip -t`,
 * which validates every CRC and the central directory, and Python's `zipfile`,
 * which extracts it.
 *
 * Filenames are UTF-8 with the general-purpose flag set, so accented titles
 * are correct per spec. One caveat worth knowing: the Info-ZIP 6.00 that macOS
 * still ships (2009) ignores that flag and mangles them on extraction. Finder,
 * Windows, Obsidian and every modern reader are fine, and transliterating
 * French titles to please one legacy CLI is the worse trade.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
  offset: number;
}

/** A standalone ArrayBuffer, which is what Blob accepts. */
function buffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/** Little-endian writer, which is the only byte order ZIP uses. */
function bytes(...values: Array<[size: 2 | 4, value: number]>): Uint8Array {
  const out = new Uint8Array(values.reduce((n, [size]) => n + size, 0));
  let at = 0;
  for (const [size, value] of values) {
    for (let i = 0; i < size; i++) out[at + i] = (value >>> (i * 8)) & 0xff;
    at += size;
  }
  return out;
}

/**
 * Pack files into a ZIP.
 *
 * @param files - Paths use `/`; a leading slash is not allowed by the format.
 */
export function zip(files: Array<{ path: string; text: string }>): Blob {
  const encoder = new TextEncoder();
  const parts: ArrayBuffer[] = [];
  const entries: Entry[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.path.replace(/^\/+/, ''));
    const data = encoder.encode(file.text);
    const entry: Entry = { name, data, crc: crc32(data), offset };
    entries.push(entry);

    // local file header: signature, version, flags, method 0 (stored), time,
    // date, crc, sizes, name length, extra length
    const header = bytes(
      [4, 0x04034b50],
      [2, 20],
      [2, 0x0800], // UTF-8 names, so accented titles survive
      [2, 0],
      [2, 0],
      [2, 0],
      [4, entry.crc],
      [4, data.length],
      [4, data.length],
      [2, name.length],
      [2, 0],
    );
    parts.push(buffer(header), buffer(name), buffer(data));
    offset += header.length + name.length + data.length;
  }

  const directoryStart = offset;
  for (const entry of entries) {
    const record = bytes(
      [4, 0x02014b50],
      [2, 20],
      [2, 20],
      [2, 0x0800],
      [2, 0],
      [2, 0],
      [2, 0],
      [4, entry.crc],
      [4, entry.data.length],
      [4, entry.data.length],
      [2, entry.name.length],
      [2, 0],
      [2, 0],
      [2, 0],
      [2, 0],
      [4, 0],
      [4, entry.offset],
    );
    parts.push(buffer(record), buffer(entry.name));
    offset += record.length + entry.name.length;
  }

  parts.push(
    buffer(bytes(
      [4, 0x06054b50],
      [2, 0],
      [2, 0],
      [2, entries.length],
      [2, entries.length],
      [4, offset - directoryStart],
      [4, directoryStart],
      [2, 0],
    )),
  );

  return new Blob(parts, { type: 'application/zip' });
}

/** Hand a blob to the user as a download. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // the object URL pins the blob in memory until it is revoked
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

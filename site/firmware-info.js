// Parsing of ESP-IDF flash structures: the partition table, the OTA data
// partition and the app descriptor at the start of an app image. Pure
// functions over Uint8Array so they run in the browser and under `node --test`.

export const PARTITION_TABLE_OFFSET = 0x8000;
export const PARTITION_TABLE_SIZE = 0xc00;
export const OTADATA_READ_SIZE = 0x2000;

const PARTITION_ENTRY_SIZE = 32;
const PARTITION_MAGIC = 0x50aa; // bytes AA 50, read little-endian
const PARTITION_MD5_MAGIC = 0xebeb;

const TYPE_APP = 0x00;
const TYPE_DATA = 0x01;
const SUBTYPE_FACTORY = 0x00;
const SUBTYPE_OTA_0 = 0x10;
const SUBTYPE_OTA_15 = 0x1f;
const SUBTYPE_DATA_OTA = 0x00;

const IMAGE_MAGIC = 0xe9;
// esp_image_header_t (24 bytes) + esp_image_segment_header_t (8 bytes).
const APP_DESC_OFFSET = 0x20;
const APP_DESC_MAGIC = 0xabcd5432;
// Bytes to read from the start of an app partition: the image and segment
// headers plus the fields of esp_app_desc_t used here (up to idf_ver).
export const APP_HEADER_READ_SIZE = APP_DESC_OFFSET + 144;

const OTA_SELECT_ENTRY_SIZE = 32;
const OTA_SECTOR_SIZE = 0x1000;

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function cString(bytes, start, length) {
  const field = bytes.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
}

/**
 * Parses an ESP-IDF partition table.
 * @param {Uint8Array} bytes - Contents of flash from PARTITION_TABLE_OFFSET.
 * @returns {{type: number, subtype: number, offset: number, size: number, label: string}[]}
 * @throws {Error} If the data doesn't start with a valid partition entry.
 */
export function parsePartitionTable(bytes) {
  const dv = view(bytes);
  const entries = [];
  for (let pos = 0; pos + PARTITION_ENTRY_SIZE <= bytes.length; pos += PARTITION_ENTRY_SIZE) {
    const magic = dv.getUint16(pos, true);
    if (magic !== PARTITION_MAGIC) {
      if (magic === PARTITION_MD5_MAGIC || magic === 0xffff) break;
      throw new Error(`Invalid partition table entry at 0x${pos.toString(16)}`);
    }
    entries.push({
      type: bytes[pos + 2],
      subtype: bytes[pos + 3],
      offset: dv.getUint32(pos + 4, true),
      size: dv.getUint32(pos + 8, true),
      label: cString(bytes, pos + 12, 16),
    });
  }
  if (entries.length === 0) throw new Error("No partition table found");
  return entries;
}

let crcTable;

/**
 * CRC-32 (IEEE, reflected) with ESP-IDF's esp_rom_crc32_le() seeding:
 * matches Python's binascii.crc32(data, init).
 */
export function crc32le(bytes, init = 0xffffffff) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = ~init >>> 0;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Returns the OTA data partition entry, or undefined if the table has none. */
export function findOtaDataPartition(partitions) {
  return partitions.find((p) => p.type === TYPE_DATA && p.subtype === SUBTYPE_DATA_OTA);
}

/**
 * Picks the app partition the bootloader will boot, following the same rule
 * as ESP-IDF's bootloader: the valid OTA select entry with the highest
 * sequence number selects ota_[(seq - 1) % count]; otherwise factory, or
 * ota_0 if there is no factory app.
 * @param {ReturnType<typeof parsePartitionTable>} partitions
 * @param {Uint8Array} [otadata] - First OTADATA_READ_SIZE bytes of the OTA
 *   data partition, required when the table has one.
 * @returns The partition entry to read the app from.
 * @throws {Error} If the table has no app partition.
 */
export function selectBootPartition(partitions, otadata) {
  const factory = partitions.find((p) => p.type === TYPE_APP && p.subtype === SUBTYPE_FACTORY);
  const otaApps = partitions
    .filter((p) => p.type === TYPE_APP && p.subtype >= SUBTYPE_OTA_0 && p.subtype <= SUBTYPE_OTA_15)
    .sort((a, b) => a.subtype - b.subtype);
  const fallback = factory ?? otaApps[0];
  if (!fallback) throw new Error("Partition table has no app partition");
  if (!findOtaDataPartition(partitions) || otaApps.length === 0 || !otadata) return fallback;

  const dv = view(otadata);
  let best = null;
  for (const base of [0, OTA_SECTOR_SIZE]) {
    if (base + OTA_SELECT_ENTRY_SIZE > otadata.length) continue;
    const seq = dv.getUint32(base, true);
    const crc = dv.getUint32(base + 28, true);
    if (seq === 0xffffffff) continue;
    if (crc !== crc32le(otadata.subarray(base, base + 4))) continue;
    if (best === null || seq > best) best = seq;
  }
  if (best === null) return fallback;
  return otaApps[(best - 1) % otaApps.length];
}

/**
 * Reads the app descriptor (esp_app_desc_t) from the start of an app image.
 * @param {Uint8Array} bytes - At least APP_HEADER_READ_SIZE bytes from the
 *   start of an app partition.
 * @returns {{version: string, projectName: string, time: string, date: string, idfVersion: string} | null}
 *   null if no app image is there (e.g. erased flash).
 */
export function parseAppDescriptor(bytes) {
  if (bytes.length < APP_HEADER_READ_SIZE) throw new Error("App header data too short");
  if (bytes[0] !== IMAGE_MAGIC) return null;
  if (view(bytes).getUint32(APP_DESC_OFFSET, true) !== APP_DESC_MAGIC) return null;
  const d = APP_DESC_OFFSET;
  return {
    version: cString(bytes, d + 16, 32),
    projectName: cString(bytes, d + 48, 32),
    time: cString(bytes, d + 80, 16),
    date: cString(bytes, d + 96, 16),
    idfVersion: cString(bytes, d + 112, 32),
  };
}

/**
 * Compares two "major.minor.patch" versions.
 * @returns {number | null} Negative, zero or positive like a sort comparator,
 *   or null if either isn't in that form.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? m.slice(1).map(Number) : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

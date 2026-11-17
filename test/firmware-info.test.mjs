import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_HEADER_READ_SIZE,
  compareVersions,
  crc32le,
  parseAppDescriptor,
  parsePartitionTable,
  selectBootPartition,
} from "../site/firmware-info.js";

function partitionEntry(type, subtype, offset, size, label) {
  const e = new Uint8Array(32);
  const dv = new DataView(e.buffer);
  e[0] = 0xaa;
  e[1] = 0x50;
  e[2] = type;
  e[3] = subtype;
  dv.setUint32(4, offset, true);
  dv.setUint32(8, size, true);
  e.set(new TextEncoder().encode(label), 12);
  return e;
}

function partitionTable(...entries) {
  const table = new Uint8Array(0xc00).fill(0xff);
  entries.forEach((e, i) => table.set(e, i * 32));
  // MD5 entry, as written by gen_esp32part.py
  table.set([0xeb, 0xeb], entries.length * 32);
  return table;
}

// ESP-IDF's default "single factory app" table.
const singleApp = partitionTable(
  partitionEntry(1, 0x02, 0x9000, 0x6000, "nvs"),
  partitionEntry(1, 0x01, 0xf000, 0x1000, "phy_init"),
  partitionEntry(0, 0x00, 0x10000, 0x100000, "factory"),
);

// ESP-IDF's "factory app, two OTA definitions" table.
const twoOta = partitionTable(
  partitionEntry(1, 0x02, 0x9000, 0x4000, "nvs"),
  partitionEntry(1, 0x00, 0xd000, 0x2000, "otadata"),
  partitionEntry(1, 0x01, 0xf000, 0x1000, "phy_init"),
  partitionEntry(0, 0x00, 0x10000, 0x100000, "factory"),
  partitionEntry(0, 0x10, 0x110000, 0x100000, "ota_0"),
  partitionEntry(0, 0x11, 0x210000, 0x100000, "ota_1"),
);

function otadata(...seqs) {
  const data = new Uint8Array(0x2000).fill(0xff);
  seqs.forEach((seq, i) => {
    if (seq === null) return;
    const base = i * 0x1000;
    const dv = new DataView(data.buffer, base, 32);
    dv.setUint32(0, seq, true);
    dv.setUint32(28, crc32le(data.subarray(base, base + 4)), true);
  });
  return data;
}

function appHeader({ version, project, time = "11:23:45", date = "Nov  5 2026", idf = "v5.5.5" }) {
  const b = new Uint8Array(APP_HEADER_READ_SIZE);
  const enc = new TextEncoder();
  b[0] = 0xe9;
  new DataView(b.buffer).setUint32(0x20, 0xabcd5432, true);
  b.set(enc.encode(version), 0x20 + 16);
  b.set(enc.encode(project), 0x20 + 48);
  b.set(enc.encode(time), 0x20 + 80);
  b.set(enc.encode(date), 0x20 + 96);
  b.set(enc.encode(idf), 0x20 + 112);
  return b;
}

test("crc32le matches binascii.crc32(struct.pack('I', seq), 0xFFFFFFFF)", () => {
  const le = (n) => new Uint8Array(new Uint32Array([n]).buffer);
  assert.equal(crc32le(le(1)), 0x4743989a);
  assert.equal(crc32le(le(2)), 0x55f63774);
  assert.equal(crc32le(le(3)), 0xed4a5011);
  assert.equal(crc32le(le(0x12345678)), 0x71d6a731);
});

test("parses the single-app partition table and boots factory", () => {
  const parts = parsePartitionTable(singleApp);
  assert.deepEqual(
    parts.map((p) => p.label),
    ["nvs", "phy_init", "factory"],
  );
  assert.equal(selectBootPartition(parts).offset, 0x10000);
});

test("rejects erased or garbage partition tables", () => {
  assert.throws(() => parsePartitionTable(new Uint8Array(0xc00).fill(0xff)), /No partition table/);
  assert.throws(() => parsePartitionTable(new Uint8Array(0xc00)), /Invalid partition table entry/);
});

test("OTA: no valid select entry boots factory", () => {
  const parts = parsePartitionTable(twoOta);
  assert.equal(selectBootPartition(parts, otadata(null, null)).label, "factory");
});

test("OTA: highest valid sequence picks the slot", () => {
  const parts = parsePartitionTable(twoOta);
  assert.equal(selectBootPartition(parts, otadata(1, null)).label, "ota_0");
  assert.equal(selectBootPartition(parts, otadata(1, 2)).label, "ota_1");
  assert.equal(selectBootPartition(parts, otadata(3, 2)).label, "ota_0");
});

test("OTA: entries with a bad CRC are ignored", () => {
  const parts = parsePartitionTable(twoOta);
  const data = otadata(1, 2);
  data[0x1000 + 28] ^= 0xff; // corrupt seq 2's CRC
  assert.equal(selectBootPartition(parts, data).label, "ota_0");
});

test("reads the app descriptor", () => {
  const app = parseAppDescriptor(appHeader({ version: "0.2.0", project: "scale_bridge" }));
  assert.deepEqual(app, {
    version: "0.2.0",
    projectName: "scale_bridge",
    time: "11:23:45",
    date: "Nov  5 2026",
    idfVersion: "v5.5.5",
  });
});

test("erased flash or a non-IDF image has no app descriptor", () => {
  assert.equal(parseAppDescriptor(new Uint8Array(APP_HEADER_READ_SIZE).fill(0xff)), null);
  const noDesc = appHeader({ version: "1.0.0", project: "x" });
  noDesc[0x20] = 0;
  assert.equal(parseAppDescriptor(noDesc), null);
});

test("compareVersions", () => {
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
  assert.ok(compareVersions("0.1.9", "0.2.0") < 0);
  assert.ok(compareVersions("1.0.0", "0.10.0") > 0);
  assert.ok(compareVersions("v0.10.0", "0.9.0") > 0);
  assert.equal(compareVersions("0.2.0-dirty", "0.2.0"), null);
});

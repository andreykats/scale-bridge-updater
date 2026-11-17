import { ESPLoader, Transport } from "./vendor/esptool.js";
import {
  APP_HEADER_READ_SIZE,
  OTADATA_READ_SIZE,
  PARTITION_TABLE_OFFSET,
  PARTITION_TABLE_SIZE,
  compareVersions,
  findOtaDataPartition,
  parseAppDescriptor,
  parsePartitionTable,
  selectBootPartition,
} from "./firmware-info.js";

const ESPRESSIF_VID = 0x303a;
const BAUD = 115200; // USB-Serial/JTAG ignores the baud rate
const EXPECTED_CHIP = "ESP32-S3";
// Resetting the chip can make the USB port drop and re-enumerate. Plug-in
// events within this window after our own reset are ignored, so they don't
// start another check.
const RESET_SETTLE_MS = 4000;

const $ = (id) => document.getElementById(id);
const ui = {
  unsupported: $("unsupported"),
  available: $("available"),
  steps: $("steps"),
  board: $("board"),
  chip: $("board-chip"),
  installed: $("board-installed"),
  status: $("status"),
  progress: $("progress"),
  connect: $("connect"),
  flash: $("flash"),
  log: $("log"),
};

let manifest = null;
let port = null;
let busy = false;
let ignoreConnectUntil = 0;

function log(line) {
  ui.log.textContent += line + "\n";
  ui.log.scrollTop = ui.log.scrollHeight;
}

function setStatus(text, kind = "") {
  ui.status.textContent = text;
  ui.status.className = `status ${kind}`;
}

function setProgress(value) {
  ui.progress.hidden = value === null;
  if (value !== null) ui.progress.value = value;
}

function setBusy(value) {
  busy = value;
  ui.connect.disabled = value || !("serial" in navigator);
  ui.flash.disabled = value || !manifest;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Turns esptool-js and Web Serial errors into something an end user can act on. */
function explain(err) {
  const msg = String(err?.message ?? err);
  if (err?.name === "NetworkError" || /Failed to open serial port/i.test(msg)) {
    return "Couldn't open the board's USB port. Close any other program using it (serial monitor, idf.py, Arduino IDE, another browser tab) and try again.";
  }
  if (/device has been lost|disconnected|The port is closed/i.test(msg)) {
    return "The board was unplugged.";
  }
  if (/Failed to connect|Timeout|timed out/i.test(msg)) {
    return "The board didn't respond. Unplug it, plug it back in and try again. If it still fails, hold the BOOT button while plugging it in.";
  }
  return msg;
}

/**
 * Opens the port, resets the chip into its ROM bootloader and runs `task`
 * with the loader. Always resets the chip back into its firmware and closes
 * the port afterwards, so the bridge keeps working whatever happens.
 */
async function withBootloader(selectedPort, task) {
  const transport = new Transport(selectedPort, false);
  const loader = new ESPLoader({
    transport,
    baudrate: BAUD,
    romBaudrate: BAUD,
    terminal: { clean() {}, writeLine: log, write: log },
  });
  let synced = false;
  try {
    await loader.main("default_reset");
    synced = true;
    if (loader.chip.CHIP_NAME !== EXPECTED_CHIP) {
      throw new Error(`This board is an ${loader.chip.CHIP_NAME}, not the bridge's ${EXPECTED_CHIP}.`);
    }
    return await task(loader);
  } finally {
    ignoreConnectUntil = Date.now() + RESET_SETTLE_MS;
    if (synced) {
      try {
        await loader.after("hard_reset");
      } catch (err) {
        log(`Reset failed: ${err.message}`);
      }
    }
    try {
      await transport.disconnect();
    } catch (err) {
      log(`Closing the port failed: ${err.message}`);
    }
  }
}

/**
 * Reads flash in small pieces. esptool-js asks the stub for 4 KB packets, and
 * over the ESP32-S3's USB-Serial/JTAG in Chrome on macOS any packet larger
 * than ~640 bytes stalls part way and never completes (Python esptool reading
 * the same board is fine). Reads of up to 512 bytes complete reliably.
 */
const READ_CHUNK = 256;

async function readFlash(loader, addr, size) {
  const out = new Uint8Array(size);
  for (let pos = 0; pos < size; pos += READ_CHUNK) {
    out.set(await loader.readFlash(addr + pos, Math.min(READ_CHUNK, size - pos)), pos);
  }
  return out;
}

/** Reads the app descriptor of the firmware the bootloader will boot. */
async function readInstalled(loader) {
  const partitions = parsePartitionTable(await readFlash(loader, PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE));
  const otadataPart = findOtaDataPartition(partitions);
  const otadata = otadataPart ? await readFlash(loader, otadataPart.offset, OTADATA_READ_SIZE) : undefined;
  const app = selectBootPartition(partitions, otadata);
  log(`Boot partition: ${app.label} at 0x${app.offset.toString(16)}`);
  return parseAppDescriptor(await readFlash(loader, app.offset, APP_HEADER_READ_SIZE));
}

function readInstalledSafely(loader) {
  return readInstalled(loader).catch((err) => {
    // Erased or corrupt flash has no valid partition table.
    log(`Couldn't read installed firmware: ${err.message}`);
    return null;
  });
}

function describeInstalled(app) {
  if (!app) return "No firmware";
  const name = app.projectName === manifest?.project ? "Scale Bridge" : `Other firmware (${app.projectName})`;
  return `${name} ${app.version}, built ${app.date} ${app.time}`;
}

/** Shows the installed firmware and offers the matching install action. */
function showBoard(chip, app) {
  ui.board.hidden = false;
  ui.steps.hidden = true;
  ui.chip.textContent = chip;
  ui.installed.textContent = describeInstalled(app);
  ui.connect.textContent = "Check again";

  if (!manifest) {
    ui.flash.hidden = true;
    return;
  }
  const v = manifest.version;
  ui.flash.hidden = false;
  if (!app) {
    setStatus("No firmware is installed on this board.");
    ui.flash.textContent = `Install ${v}`;
  } else if (app.projectName !== manifest.project) {
    setStatus("This board runs different firmware. Installing replaces it.", "warn");
    ui.flash.textContent = `Replace with Scale Bridge ${v}`;
  } else {
    const cmp = compareVersions(app.version, v);
    if (cmp === 0) {
      setStatus("Firmware is up to date.", "ok");
      ui.flash.textContent = `Reinstall ${v}`;
    } else if (cmp !== null && cmp > 0) {
      setStatus(`The installed firmware is newer than ${v}.`, "warn");
      ui.flash.textContent = `Downgrade to ${v}`;
    } else {
      setStatus(`An update is available: ${app.version} → ${v}.`);
      ui.flash.textContent = `Update to ${v}`;
    }
  }
}

async function inspect(selectedPort) {
  if (busy) return;
  setBusy(true);
  port = selectedPort;
  setProgress(null);
  setStatus("Reading the board… (it restarts, so phones disconnect for a few seconds)");
  try {
    const { chip, app } = await withBootloader(port, async (loader) => ({
      chip: await loader.chip.getChipDescription(loader),
      app: await readInstalledSafely(loader),
    }));
    showBoard(chip, app);
  } catch (err) {
    log(`Error: ${err.stack ?? err}`);
    setStatus(explain(err), "error");
  } finally {
    setBusy(false);
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Downloads the release binaries and checks them against the manifest. */
async function downloadFirmware() {
  return Promise.all(
    manifest.files.map(async (f) => {
      const res = await fetch(f.path, { cache: "no-cache" });
      if (!res.ok) throw new Error(`Download of ${f.path} failed (HTTP ${res.status})`);
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.length !== f.size || (await sha256Hex(data)) !== f.sha256) {
        throw new Error(`Download of ${f.path} is corrupt; reload the page and try again.`);
      }
      return { address: f.address, data };
    }),
  );
}

function md5Hex(image) {
  return globalThis.SparkMD5.ArrayBuffer.hash(
    image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength),
  );
}

async function flash() {
  if (busy || !port || !manifest) return;
  setBusy(true);
  setProgress(0);
  try {
    setStatus("Downloading firmware…");
    const fileArray = await downloadFirmware();
    const sizes = fileArray.map((f) => f.data.length);
    const total = sizes.reduce((a, b) => a + b, 0);
    const before = sizes.map((_, i) => sizes.slice(0, i).reduce((a, b) => a + b, 0));

    // writeFlash checks each file's MD5 on the board against the release and
    // throws on a mismatch, so a completed write is verified byte for byte.
    setStatus("Installing firmware… Don't unplug the board.");
    await withBootloader(port, (loader) =>
      loader.writeFlash({
        fileArray,
        flashMode: manifest.flash.mode,
        flashFreq: manifest.flash.freq,
        flashSize: manifest.flash.size,
        eraseAll: false,
        compress: true,
        calculateMD5Hash: md5Hex,
        reportProgress: (i, written, compressedTotal) =>
          setProgress((before[i] + sizes[i] * (written / compressedTotal)) / total),
      }),
    );
    setProgress(null);
    showBoard(ui.chip.textContent, {
      projectName: manifest.project,
      version: manifest.version,
      date: manifest.date,
      time: manifest.time,
    });
    setStatus(`Installed ${manifest.version}. The bridge has restarted and is running the new firmware.`, "ok");
  } catch (err) {
    log(`Error: ${err.stack ?? err}`);
    setProgress(null);
    setStatus(`${explain(err)} The board may need the update run again before it works.`, "error");
  } finally {
    setBusy(false);
  }
}

async function loadManifest() {
  try {
    const res = await fetch("manifest.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const m = await res.json();
    if (typeof m.version !== "string" || !Array.isArray(m.files) || m.files.length === 0 || !m.flash) {
      throw new Error("malformed manifest");
    }
    manifest = m;
    ui.available.textContent = `Scale Bridge ${m.version}, built ${m.date} ${m.time}`;
  } catch (err) {
    log(`Manifest: ${err.message}`);
    ui.available.textContent = "Couldn't load the firmware list. Reload the page to try again.";
    ui.available.className = "status error";
  }
}

function isEspressifPort(p) {
  return p.getInfo().usbVendorId === ESPRESSIF_VID;
}

async function init() {
  if (!("serial" in navigator)) {
    ui.unsupported.hidden = false;
    setBusy(false);
    await loadManifest();
    return;
  }

  ui.connect.addEventListener("click", async () => {
    let selected;
    try {
      selected = await navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] });
    } catch {
      return; // chooser cancelled
    }
    inspect(selected);
  });
  ui.flash.addEventListener("click", flash);

  // Once the site has been allowed to use the board, plugging it in again
  // starts the check without going through the chooser.
  navigator.serial.addEventListener("connect", (e) => {
    const p = e.port ?? e.target;
    if (!isEspressifPort(p)) return;
    if (Date.now() < ignoreConnectUntil) {
      // Our own reset re-enumerated the board: keep the fresh port handle.
      if (port) port = p;
      return;
    }
    inspect(p);
  });
  navigator.serial.addEventListener("disconnect", (e) => {
    const p = e.port ?? e.target;
    if (busy || p !== port || Date.now() < ignoreConnectUntil) return;
    port = null;
    ui.board.hidden = true;
    ui.flash.hidden = true;
    ui.steps.hidden = false;
    ui.connect.textContent = "Connect";
    setStatus("Board unplugged.");
  });

  setBusy(true);
  await loadManifest();
  setBusy(false);

  const known = (await navigator.serial.getPorts()).filter(isEspressifPort);
  if (known.length === 1) inspect(known[0]);
}

init();

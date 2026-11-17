#!/usr/bin/env node
// Builds the release firmware in a scale-bridge-firmware checkout and stages
// the updater site with those binaries into dist/.
//
//   node scripts/build.mjs [--firmware <path>] [--allow-dirty]
//
// --firmware     scale-bridge-firmware checkout (default: ../scale-bridge-firmware)
// --allow-dirty  build even if the firmware checkout has uncommitted changes
// IDF_PATH       ESP-IDF install (default: ~/.esp/esp-idf)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { APP_HEADER_READ_SIZE, parseAppDescriptor } from "../site/firmware-info.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const PROJECT_NAME = "scale_bridge";
const CHIP = "esp32s3";
const BUILD_DIR = "build-release";

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`can't read ${path}: ${err.message}`);
  }
}

let args;
try {
  args = parseArgs({
    options: {
      firmware: { type: "string", default: join(root, "..", "scale-bridge-firmware") },
      "allow-dirty": { type: "boolean", default: false },
    },
  }).values;
} catch (err) {
  fail(err.message);
}

const firmwareRepo = resolve(args.firmware);
const firmwareDir = join(firmwareRepo, "firmware");
const idfPath = process.env.IDF_PATH || join(homedir(), ".esp", "esp-idf");
if (!existsSync(join(firmwareDir, "CMakeLists.txt"))) fail(`no firmware project at ${firmwareDir}`);
if (!existsSync(join(idfPath, "export.sh"))) fail(`no ESP-IDF at ${idfPath} (set IDF_PATH)`);

// The published binary should match a commit in the firmware repo.
const git = (...a) => execFileSync("git", ["-C", firmwareRepo, ...a], { encoding: "utf8" }).trim();
let commit;
try {
  if (git("status", "--porcelain") && !args["allow-dirty"]) {
    fail(`${firmwareRepo} has uncommitted changes (commit them or pass --allow-dirty)`);
  }
  commit = git("rev-parse", "--short", "HEAD");
} catch (err) {
  fail(`git failed in ${firmwareRepo}: ${err.message}`);
}

// Release build in its own directory, regenerated from sdkconfig.defaults
// alone so simulator or menuconfig settings can't leak in.
const buildDir = join(firmwareDir, BUILD_DIR);
rmSync(join(buildDir, "sdkconfig"), { force: true });
console.log(`Building release firmware in ${buildDir} ...`);
try {
  execFileSync(
    "bash",
    [
      "-c",
      '. "$IDF_PATH/export.sh" >/dev/null && idf.py -B "$1" -D SDKCONFIG="$1/sdkconfig" -D SDKCONFIG_DEFAULTS=sdkconfig.defaults build',
      "build",
      BUILD_DIR,
    ],
    { cwd: firmwareDir, stdio: "inherit", env: { ...process.env, IDF_PATH: idfPath } },
  );
} catch {
  fail("idf.py build failed");
}

const sdkconfig = readFileSync(join(buildDir, "sdkconfig"), "utf8");
if (/^CONFIG_SCALE_SIMULATOR=y$/m.test(sdkconfig)) fail("release build has CONFIG_SCALE_SIMULATOR enabled");

const flasherArgs = readJson(join(buildDir, "flasher_args.json"));
const chip = flasherArgs.extra_esptool_args?.chip;
if (chip !== CHIP) fail(`build is for chip "${chip}", expected "${CHIP}"`);
const { flash_mode: mode, flash_freq: freq, flash_size: size } = flasherArgs.flash_settings ?? {};
if (!mode || !freq || !size) fail("flasher_args.json has no flash_settings");
const flashFiles = Object.entries(flasherArgs.flash_files ?? {});
if (flashFiles.length === 0) fail("flasher_args.json lists no flash files");

const appFile = flasherArgs.app?.file;
if (!appFile) fail("flasher_args.json has no app entry");
const app = parseAppDescriptor(readFileSync(join(buildDir, appFile)).subarray(0, APP_HEADER_READ_SIZE));
if (!app) fail(`${appFile} has no app descriptor`);
if (app.projectName !== PROJECT_NAME) fail(`app project is "${app.projectName}", expected "${PROJECT_NAME}"`);

// Stage the site.
rmSync(dist, { recursive: true, force: true });
cpSync(join(root, "site"), dist, { recursive: true });
writeFileSync(join(dist, ".nojekyll"), "");

const vendor = join(dist, "vendor");
mkdirSync(vendor);
cpSync(join(root, "node_modules", "esptool-js", "bundle.js"), join(vendor, "esptool.js"));
cpSync(join(root, "node_modules", "esptool-js", "LICENSE"), join(vendor, "esptool-js.LICENSE"));
cpSync(join(root, "node_modules", "spark-md5", "spark-md5.min.js"), join(vendor, "spark-md5.min.js"));
cpSync(join(root, "node_modules", "spark-md5", "LICENSE"), join(vendor, "spark-md5.LICENSE"));

// Binaries go under their version so browsers never mix cached files from
// different releases.
const fwDir = join("firmware", app.version);
mkdirSync(join(dist, fwDir), { recursive: true });
const files = flashFiles
  .map(([address, file]) => {
    const data = readFileSync(join(buildDir, file));
    const name = file.split("/").pop();
    writeFileSync(join(dist, fwDir, name), data);
    return {
      address: Number(address),
      path: `${fwDir}/${name}`,
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  })
  .sort((a, b) => a.address - b.address);
if (files.some((f) => !Number.isInteger(f.address))) fail("flasher_args.json has a non-numeric address");

const manifest = {
  project: PROJECT_NAME,
  chip: "ESP32-S3",
  version: app.version,
  date: app.date,
  time: app.time,
  firmwareCommit: commit,
  idfVersion: app.idfVersion,
  flash: { mode, freq, size },
  files,
};
writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Staged firmware ${app.version} (${commit}) in ${dist}`);

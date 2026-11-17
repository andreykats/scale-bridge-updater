# CLAUDE.md

Developer notes. End-user instructions are in [README.md](README.md).

Static site that flashes the Scale Bridge firmware over Web Serial using [esptool-js](https://github.com/espressif/esptool-js). The firmware source is in the private `scale-bridge-firmware` repo, expected as a sibling checkout (`../scale-bridge-firmware`). This repo is public; only compiled binaries are published, on the `gh-pages` branch.

## Layout

- `site/`: the page. Plain HTML/CSS/ES modules, no bundler.
  - `app.js`: UI and esptool-js flow.
  - `firmware-info.js`: pure parsers for the partition table, OTA data and `esp_app_desc_t`; shared with `scripts/build.mjs` and the tests.
- `scripts/build.mjs`: builds the release firmware and stages the site into `dist/`.
- `scripts/deploy.sh`: force-pushes `dist/` as a single commit to `gh-pages`.
- `test/`: `node --test` unit tests for `firmware-info.js`.

## Build, test, deploy

```sh
npm ci
npm test
npm run build      # builds firmware, stages dist/ (needs ESP-IDF at ~/.esp/esp-idf or $IDF_PATH)
npm run serve      # http://localhost:8000; Web Serial works on localhost
npm run deploy     # publish dist/ to gh-pages
```

`build.mjs` options: `--firmware <path>` for a different firmware checkout, `--allow-dirty` to build with uncommitted firmware changes (the manifest records the firmware commit, so avoid publishing those).

The release build runs in the firmware's `firmware/build-release/`, regenerating `sdkconfig` from `sdkconfig.defaults` alone each time so simulator or menuconfig settings can't leak in; the script also refuses a build with `CONFIG_SCALE_SIMULATOR=y`. Flash offsets and mode/freq/size come from the build's `flasher_args.json`, the version from the app image's own descriptor (`PROJECT_VER` in the firmware's `CMakeLists.txt`). Bump `PROJECT_VER` for each release, or the page reports "up to date" to boards running an older build with the same version.

`dist/` layout: `manifest.json` (version, flash settings, files with address/size/SHA-256), `firmware/<version>/*.bin`, `vendor/` (esptool-js `bundle.js` and spark-md5, copied from `node_modules` with their licenses).

## How the page works

- Port chooser is filtered to Espressif's USB VID `0x303A`; the Zero's native USB-Serial/JTAG is PID `0x1001`.
- **Detect**: `ESPLoader.main()` resets into the ROM bootloader (esptool-js picks the USB-Serial/JTAG reset sequence from the VID/PID), reads the partition table at `0x8000` (in 256-byte pieces; see below), picks the boot app (factory, or the OTA slot selected by `otadata`, as the IDF bootloader does), and reads `esp_app_desc_t` at app offset + `0x20`. Then hard-resets back into the firmware and closes the port, so the bridge keeps working if the user walks away.
- **Flash**: downloads the binaries, checks size and SHA-256 against the manifest, writes them with `writeFlash` (compressed; after each file the stub's MD5 of the flash region is compared with spark-md5's, and a mismatch throws), then hard-resets. No version read-back: the MD5 check is stronger, and a read straight after a large write failed once (see below). NVS is not erased.
- Plug-in auto-detect uses `navigator.serial` `connect` events for previously granted ports. Our own resets can re-enumerate the USB device, so `connect`/`disconnect` events are ignored for a few seconds after each reset (the fresh port handle is kept).

## esptool-js read problem (Chrome, macOS, ESP32-S3 USB-Serial/JTAG)

`ESPLoader.readFlash` asks the stub for 4 KB packets. On the Zero in Chrome on macOS, any packet over ~640 bytes stalls part way (569-766 bytes arrive, then nothing) and the call only fails after its 100 s timeout. Python esptool reads the same board in 4 KB packets with either stub version, and a larger Web Serial `bufferSize`, toggling DTR or 64 packets in flight don't help. Reads of up to 512 bytes work reliably, so `app.js` reads in 256-byte pieces through the public `readFlash` (each call's leftover MD5 frame is discarded by esptool-js's `flushInput` before the next command). Once, a read straight after a full three-file write got no response; it didn't reproduce in four further attempts. Worth reporting upstream to espressif/esptool-js with the numbers above.

## Testing status

- Unit tests cover the parsers, with OTA CRC vectors from Python's `binascii.crc32` (what ESP-IDF's `otatool.py` uses).
- Tested on a Waveshare ESP32-S3-Zero in Chrome on macOS: auto-detect of a previously granted port, version detection, and Reinstall (all three files MD5-verified); the board then boots the new build, advertises over BLE and starts the scale UART.
- Not yet tested: Windows/Linux, Edge, a blank or non-Scale-Bridge board, an actual version upgrade, unplugging mid-update.

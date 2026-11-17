# Scale Bridge Firmware Updater

A web page that updates the firmware on a Scale Bridge (the ESP32-S3-Zero that connects a Brecknell LPS-150 scale to the LPS Scale iPhone app) over USB. Nothing to install.

**Open: <https://andreykats.github.io/scale-bridge-updater/>**

## Updating

1. Open the page in **Chrome** or **Edge** on a computer (Windows, macOS, Linux or ChromeOS). Safari, Firefox and phones can't talk to USB serial devices.
2. Plug the bridge's USB-C port into the computer.
3. Click **Connect** and pick the board from the list. It shows up as *USB JTAG/serial debug unit*.
4. The page shows the installed firmware version and the latest one. Click **Update** (or **Install**/**Reinstall**).
5. Wait until it says the firmware is installed, then unplug.

Checking and updating both restart the bridge, so connected phones drop off for a few seconds and then reconnect.

The next time you plug in the same board, the page checks it on its own without the **Connect** step.

## Troubleshooting

- **"Couldn't open the board's USB port"**: another program has the port open. Close any serial monitor, `idf.py monitor`, Arduino IDE or other tab running this page.
- **"The board didn't respond"**: unplug it and plug it back in. If it still fails, hold the **BOOT** button on the Zero while plugging it in, then click **Connect**.
- **Update stopped part way through**: run it again. The board can't boot until an update finishes, but it can always be updated again from this page.
- **The board isn't in the list**: try a different USB-C cable; some are charge-only.

## License

MIT, see [LICENSE](LICENSE). The bundled [esptool-js](https://github.com/espressif/esptool-js) (Apache-2.0) and [spark-md5](https://github.com/satazor/js-spark-md5) (WTFPL) keep their own licenses.

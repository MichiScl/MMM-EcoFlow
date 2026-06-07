# MMM-EcoFlow

MagicMirror² module that periodically connects to the EcoFlow Developer Open API (via the EcoFlow MQTT broker). The module subscribes to configured MQTT topics, filters incoming payloads according to your rules, and writes the filtered data atomically to a local JSON file so other modules can read it without blocking.

**Key features:**
- Authenticates against the EcoFlow Developer API to obtain MQTT credentials.
- Subscribes to configurable MQTT topics.
- Recursively filters nested JSON objects by a list of allowed keys.
- Writes output atomically to a JSON file (`rename`-based) to avoid partial reads.

**Note:** See the implementation in [MMM-EcoFlow/MMM-EcoFlow.js](MMM-EcoFlow/MMM-EcoFlow.js#L1-L120) and the MQTT/auth logic in [MMM-EcoFlow/node_helper.js](MMM-EcoFlow/node_helper.js#L1-L220).

## Installation

1. Copy or clone this folder into your MagicMirror `modules` directory:

```bash
cd ~/MagicMirror/modules
git clone https://github.com/yourusername/MMM-EcoFlow.git
cd MMM-EcoFlow
```

2. Install the Node dependencies used by the module:

```bash
npm install
```

3. Add the module configuration to your MagicMirror `config/config.js` (example below) and restart MagicMirror.

## Example Configuration

Add a module block to your `config/config.js`:

```js
{
  module: "MMM-EcoFlow",
  position: "top_right", // any valid MagicMirror position
  config: {
    accessKey: "YOUR_ACCESS_KEY",
    secretKey: "YOUR_SECRET_KEY",
    topics: [
      "/open/api/device/state/v1/YOUR_SERIAL_NUMBER",
      "/open/api/device/quota/v1/YOUR_SERIAL_NUMBER"
    ],
    dataFilter: ["soc", "wIn", "wOut"],
    outputFile: "modules/MMM-EcoFlow/output.json",
    apiUrl: "https://api-eu.ecoflow.com"
  }
}
```

## Configuration Parameters

- **`accessKey`**: string — API access key provided by EcoFlow developer portal. Default: `""`. Mandatory: yes — the module will not authenticate without it.
- **`secretKey`**: string — API secret key corresponding to the `accessKey`. Default: `""`. Mandatory: yes.
- **`topics`**: array — list of MQTT topics to subscribe to (e.g. `"/open/api/device/state/v1/DEVICE_SN"`). Default: `[]`. Mandatory: you should provide at least one topic to receive data.
- **`dataFilter`**: array — list of keys to retain from incoming JSON payloads. The module searches nested objects recursively and collects any matching keys. Default: `[]` (empty = do not filter; the full payload will be kept).
- **`outputFile`**: string — path to write the filtered JSON output. Default: `modules/MMM-EcoFlow/output.json`. The path is resolved relative to the MagicMirror root; ensure the process has write permissions to the containing folder.
- **`apiUrl`**: string — EcoFlow API base URL / region endpoint. Default: `https://api-eu.ecoflow.com`. Change this only if you have credentials for another regional API endpoint.

## How it works

1. The module (frontend) sends the configuration to the node helper on startup.
2. The node helper signs a request using `accessKey`/`secretKey` and calls the EcoFlow signing endpoint to obtain MQTT credentials.
3. The helper connects to EcoFlow's MQTT broker, subscribes to the configured `topics` and listens for messages.
4. Each incoming message is JSON-parsed, filtered via `dataFilter`, timestamped (converted to a readable format), and written atomically to the `outputFile`.
5. The frontend receives socket notifications for status updates and the last successful write.

## Output format

The module writes a JSON object with this structure:

```json
{
  "timestamp": "DD.MM.YYYYTHH:MM:SS",
  "data": { /* filtered key/value pairs */ }
}
```

## Troubleshooting

- If the module shows `Authenticating...` for a long time or `Connection Failed`, verify `accessKey`, `secretKey`, and `apiUrl`.
- If no messages arrive, check that your `topics` are correct (use the serial number and the topic path provided by EcoFlow documentation).
- Ensure the MagicMirror process has write permission to the `outputFile` directory.
- Check the MagicMirror logs and `node_helper.js` console output for errors. MQTT and HTTP errors are logged to the console.

## Dependencies

This module uses `axios` and `mqtt` as runtime dependencies. They are declared in `package.json` and installed by `npm install`.

## License

MIT

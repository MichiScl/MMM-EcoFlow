# MMM-EcoFlow

MagicMirror² module that bridges the EcoFlow Developer API with the MagicMirror frontend by authenticating to EcoFlow, subscribing to MQTT topics, and storing filtered sensor/device data in a JSON file.

What it does
- Uses `accessKey` and `secretKey` to request MQTT broker credentials from the EcoFlow certification endpoint.
- Connects to EcoFlow over MQTT and subscribes to the configured topics.
- Parses each incoming MQTT message as JSON.
- Recursively filters nested payloads so only the configured keys are kept.
- Writes the filtered result to `outputFile` using a temporary file and an atomic rename, which avoids partial JSON writes.
- Updates the frontend status with messages such as `Authenticating...`, `Connected to MQTT`, and `Connected & Writing`.

Installation
1. Copy or clone this folder into your MagicMirror `modules` directory:

```bash
cd ~/MagicMirror/modules
git clone https://github.com/MichiScl/MMM-EcoFlow.git
cd MMM-EcoFlow
```

2. Install the Node dependencies:

```bash
npm install
```

3. Add the module configuration to `config/config.js` and restart MagicMirror.

Example configuration

```js
{
  module: "MMM-EcoFlow",
  position: "top_right",
  config: {
    accessKey: "YOUR_ACCESS_KEY",
    secretKey: "YOUR_SECRET_KEY",
    topics: [
      "/open/api/device/state/v1/YOUR_SERIAL_NUMBER",
      "/open/api/device/quota/v1/YOUR_SERIAL_NUMBER"
    ],
    dataFilter: ["soc", "wIn", "wOut"],
    outputFile: "modules/MMM-EcoFlow/output.json",
    apiUrl: "https://api-eu.ecoflow.com",
    showModule: true
  }
}
```

Configuration parameters
- `accessKey`: API access key from the EcoFlow Developer portal. Required.
- `secretKey`: matching secret key for the API access key. Required.
- `topics`: list of MQTT topics to subscribe to. Required.
- `dataFilter`: list of keys to retain. If empty, the full payload is kept. The filter is recursive.
- `outputFile`: output JSON path. The path is resolved by the helper and folders are created automatically if needed.
- `apiUrl`: EcoFlow API base endpoint. Default: `https://api-eu.ecoflow.com`
- `showModule`: controls whether the module is rendered on the mirror. Default: `true`. Set to `false` to hide the module completely.

How the data flow works
1. The frontend sends its config to the node helper on startup.
2. The helper creates a signed request using the configured keys and calls the EcoFlow certification endpoint.
3. EcoFlow returns MQTT connection information.
4. The helper opens an MQTT connection, subscribes to the configured topics, and listens for incoming messages.
5. Each payload is parsed, filtered, timestamped, and written atomically to the selected file.
6. The frontend displays a status line and last-update timestamp based on socket notifications.

Output format

The module writes a JSON object shaped like this:

```json
{
  "timestamp": "DD.MM.YYYYTHH:MM:SS",
  "data": { }
}
```

Notes
- The timestamp in the output is created from the incoming EcoFlow timestamp, or falls back to the current system time if the payload has no timestamp.
- The helper supports nested payloads and keeps only the keys explicitly listed in `dataFilter`.
- The temporary file is named `outputFile + ".tmp"`; after the JSON is written, the file is replaced using `renameSync`.

Troubleshooting
- `Authenticating...` or `Connection Failed` typically points to bad credentials or an invalid `apiUrl`.
- No MQTT data usually means the topic path or serial number is wrong.
- If the output file cannot be written, verify the MagicMirror process has write permission to the target folder.

Dependencies
- `axios`
- `mqtt`

License
MIT

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
    deviceSerial: "YOUR_SERIAL_NUMBER",
    topics: [
      "/open/${certificateAccount}/${sn}/status",
      "/open/${certificateAccount}/${sn}/quota"
    ],
    dataFilter: ["soc", "wIn", "wOut"],
    outputFile: "modules/MMM-EcoFlow/output.json",
    apiUrl: "https://api.ecoflow.com",
    showModule: true
  }
}
```

Configuration parameters
- `accessKey`: API access key from the EcoFlow Developer portal. Required.
- `secretKey`: matching secret key for the API access key. Required.
- `topics`: list of MQTT topics to subscribe to. Required. The helper now supports the documented placeholder tokens `${certificateAccount}` and `${sn}` (or `${serial}`) and will expand them using the MQTT certificate reply and the configured serial number.
- `deviceSerial` / `sn`: optional device serial number used to resolve topic placeholders such as `${sn}` in the topic list. See [Finding the device serial number](#finding-the-device-serial-number).
- `dataFilter`: list of keys to retain. If empty, the full payload is kept. The filter is recursive.
- `outputFile`: output JSON path. The path is resolved by the helper and folders are created automatically if needed.
- `apiUrl`: EcoFlow API base endpoint. Default: `https://api.ecoflow.com`
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

Finding the device serial number

The MQTT topic format uses the device serial (`sn`) and the MQTT certificate account. To find the serial number for the account tied to your keys, run this on the Pi with the secret values kept in shell environment variables instead of pasting them into the repository or docs:

```bash
export ECOFLOW_ACCESS_KEY="YOUR_ACCESS_KEY"
export ECOFLOW_SECRET_KEY="YOUR_SECRET_KEY"
export NONCE=$(shuf -i 100000-999999 -n 1)
export TIMESTAMP=$(date +%s000)

export SIGN=$(node -e "const crypto=require('crypto'); const str='accessKey='+process.env.ECOFLOW_ACCESS_KEY+'&nonce='+process.env.NONCE+'&timestamp='+process.env.TIMESTAMP; console.log(crypto.createHmac('sha256', process.env.ECOFLOW_SECRET_KEY).update(str).digest('hex'))")

curl -sS -X GET "https://api.ecoflow.com/iot-open/sign/device/list" \
  -H "accessKey: $ECOFLOW_ACCESS_KEY" \
  -H "timestamp: $TIMESTAMP" \
  -H "nonce: $NONCE" \
  -H "sign: $SIGN" | jq '.data[] | {sn, online}'
```

The returned `sn` value is the serial number you should use in the MQTT topic configuration.

Troubleshooting
- `Authenticating...` or `Connection Failed` typically points to bad credentials or an invalid `apiUrl`.
- No MQTT data usually means the topic path or serial number is wrong.
- If the output file cannot be written, verify the MagicMirror process has write permission to the target folder.

Dependencies
- `axios`
- `mqtt`

License
MIT

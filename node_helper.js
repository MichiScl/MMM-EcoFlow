const NodeHelper = require("node_helper");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const mqtt = require("mqtt");

module.exports = NodeHelper.create({
    start: function() {
        console.log("MMM-EcoFlow helper started...");
        this.mqttClient = null;
        this.config = null;
    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === "CONFIG") {
            this.config = payload;
            console.log("MMM-EcoFlow: CONFIG received", {
                accessKey: payload.accessKey ? "present" : "missing",
                secretKey: payload.secretKey ? "present" : "missing",
                topics: Array.isArray(payload.topics) ? payload.topics : [],
                dataFilter: Array.isArray(payload.dataFilter) ? payload.dataFilter : [],
                outputFile: payload.outputFile,
                apiUrl: payload.apiUrl
            });
            this.initEcoFlowConnection();
        }
    },

    // EcoFlow Signature Generator (nach offizieller Developer Dokumentation)
    generateSignature: function(params, secretKey) {
        const sortedKeys = Object.keys(params).sort();
        let parameterString = "";
        for (const key of sortedKeys) {
            parameterString += `${key}=${params[key]}&`;
        }
        parameterString = parameterString.slice(0, -1); // Letztes '&' entfernen

        return crypto
            .createHmac("sha256", secretKey)
            .update(parameterString)
            .digest("hex");
    },

    normalizeApiUrl: function(apiUrl) {
        if (!apiUrl) {
            return "https://api.ecoflow.com";
        }

        return apiUrl
            .replace(/^https?:\/\/developer-eu\.ecoflow\.com/i, "https://api.ecoflow.com")
            .replace(/^https?:\/\/api-eu\.ecoflow\.com/i, "https://api.ecoflow.com");
    },

    // Holt die Broker-Verbindungsdaten von der EcoFlow API
    initEcoFlowConnection: async function() {
        const self = this;
        const nonce = Math.floor(Math.random() * 1000000).toString();
        const timestamp = Date.now().toString();

        const params = {
            accessKey: this.config.accessKey,
            nonce: nonce,
            timestamp: timestamp
        };

        this.config.apiUrl = this.normalizeApiUrl(this.config.apiUrl);
        const signature = this.generateSignature(params, this.config.secretKey);
        const certUrl = `${this.config.apiUrl}/iot-open/sign/certification`;

        try {
            console.log("MMM-EcoFlow: Requesting certification from", certUrl);
            this.sendSocketNotification("STATUS_UPDATE", { status: "Authenticating..." });
            
            const response = await axios.get(certUrl, {
                headers: {
                    "accessKey": this.config.accessKey,
                    "nonce": nonce,
                    "timestamp": timestamp,
                    "sign": signature
                }
            });

            const responseData = response.data;
            const responseIsHtml = typeof responseData === "string" && responseData.trim().startsWith("<!doctype html");

            console.log("MMM-EcoFlow: certification response", {
                status: response.status,
                contentType: response.headers && response.headers["content-type"],
                responseIsHtml: responseIsHtml,
                data: responseData
            });

            if (responseIsHtml) {
                console.error("MMM-EcoFlow: API endpoint returned HTML instead of JSON. Check apiUrl.", {
                    certUrl: certUrl,
                    expected: "https://api-eu.ecoflow.com"
                });
                this.sendSocketNotification("STATUS_UPDATE", { status: "Endpoint mismatch: use https://api-eu.ecoflow.com" });
                return;
            }

            if (responseData && responseData.code === "0" && responseData.data) {
                this.connectMQTT(responseData.data);
            } else {
                let msg = responseData && responseData.message ? responseData.message : "Unknown Error";
                console.error("MMM-EcoFlow: API returned non-zero code", responseData);
                this.sendSocketNotification("STATUS_UPDATE", { status: `API Error: ${msg}` });
            }
        } catch (error) {
            console.error("MMM-EcoFlow: Error fetching certification", {
                message: error.message,
                responseStatus: error.response && error.response.status,
                responseData: error.response && error.response.data
            });
            this.sendSocketNotification("STATUS_UPDATE", { status: "Connection Failed" });
        }
    },

    // Erstellt die MQTT-Verbindung mit den erhaltenen Zertifikaten
    connectMQTT: function(authData) {
        const self = this;
        const brokerUrl = `mqtts://${authData.url}:${authData.port}`;
        
        const options = {
            clientId: authData.clientId,
            username: authData.username,
            password: authData.password,
            keepalive: 60,
            reconnectPeriod: 10000,
            rejectUnauthorized: true
        };

        console.log("MMM-EcoFlow: Connecting MQTT broker", {
            brokerUrl: brokerUrl,
            clientId: authData.clientId,
            username: authData.username
        });

        this.mqttClient = mqtt.connect(brokerUrl, options);

        this.mqttClient.on("connect", () => {
            console.log("MMM-EcoFlow: MQTT connection established");
            self.sendSocketNotification("STATUS_UPDATE", { status: "Connected to MQTT" });
            
            // Abonnieren der konfigurierten Topics
            if (Array.isArray(self.config.topics)) {
                self.config.topics.forEach(topic => {
                    self.mqttClient.subscribe(topic, (err) => {
                        if (err) {
                            console.error("MMM-EcoFlow: MQTT subscribe failed for", topic, err);
                        } else {
                            console.log(`MMM-EcoFlow: Subscribed to ${topic}`);
                        }
                    });
                });
            } else {
                console.error("MMM-EcoFlow: No topics configured for MQTT subscription");
            }
        });

        this.mqttClient.on("message", (topic, message) => {
            console.log("MMM-EcoFlow: MQTT message received on", topic);
            self.processMessage(topic, message.toString());
        });

        this.mqttClient.on("error", (err) => {
            console.error("MMM-EcoFlow MQTT Error:", err);
            self.sendSocketNotification("STATUS_UPDATE", { status: "MQTT Error" });
        });
    },

    // Konvertiert Timestamps in das Format DD.MM.YYYYTHH:MM:SS
    formatTimestamp: function(apiTimestamp) {
        const date = apiTimestamp ? new Date(Number(apiTimestamp)) : new Date();
        const pad = (n) => String(n).padStart(2, '0');
        
        const day = pad(date.getDate());
        const month = pad(date.getMonth() + 1);
        const year = date.getFullYear();
        const hours = pad(date.getHours());
        const minutes = pad(date.getMinutes());
        const seconds = pad(date.getSeconds());

        return `${day}.${month}.${year}T${hours}:${minutes}:${seconds}`;
    },

    // Rekursive Filterfunktion für verschachtelte JSON-Objekte
    filterObject: function(obj, allowedKeys) {
        if (allowedKeys.length === 0) return obj;
        
        let filtered = {};
        
        // Hilfsfunktion zum Durchsuchen des Objekts
        const search = (currentObj) => {
            for (let key in currentObj) {
                if (allowedKeys.includes(key)) {
                    filtered[key] = currentObj[key];
                }
                if (currentObj[key] !== null && typeof currentObj[key] === "object") {
                    search(currentObj[key]);
                }
            }
        };
        
        search(obj);
        return filtered;
    },

    // Verarbeitet die eingehenden MQTT-Pakete, filtert und schreibt sie atomar
    processMessage: function(topic, rawMessage) {
        try {
            console.log("MMM-EcoFlow: Parsing MQTT payload for", topic);
            const parsed = JSON.parse(rawMessage);
            
            // Filter anwenden
            let extractedData = this.filterObject(parsed, this.config.dataFilter);
            
            // Timestamp ermitteln und konvertieren
            // EcoFlow liefert oft 'timestamp' oder innerhalb von 'param' bzw. 'data'
            let rawTime = parsed.timestamp || (parsed.data && parsed.data.timestamp) || null;
            const formattedTime = this.formatTimestamp(rawTime);
            
            console.log("MMM-EcoFlow: Filtered payload keys", Object.keys(extractedData));
            
            // Output-Objekt strukturieren
            const outputPayload = {
                timestamp: formattedTime,
                data: extractedData
            };

            this.writeAtomicJSON(outputPayload);
        } catch (e) {
            console.error("MMM-EcoFlow: Error processing MQTT payload", {
                topic: topic,
                rawMessage: rawMessage,
                error: e
            });
        }
    },

    // Garantiert atomarer Schreibprozess über POSIX renameSync
    writeAtomicJSON: function(data) {
        const targetPath = path.resolve(this.config.outputFile);
        const tmpPath = targetPath + ".tmp";

        try {
            console.log("MMM-EcoFlow: Writing output to", targetPath);
            
            // Ordnerstruktur erstellen, falls sie nicht existiert
            const dir = path.dirname(targetPath);
            if (!fs.existsSync(dir)){
                console.log("MMM-EcoFlow: Creating output directory", dir);
                fs.mkdirSync(dir, { recursive: true });
            }

            // 1. In die .tmp Datei schreiben
            fs.writeFileSync(tmpPath, JSON.stringify(data, null, 4), "utf8");
            
            // 2. Atomares Ersetzen im OS-Dateisystem (Linux rename)
            fs.renameSync(tmpPath, targetPath);

            console.log("MMM-EcoFlow: JSON file successfully written", targetPath);

            // Erfolg zurück an das Frontend senden
            this.sendSocketNotification("DATA_WRITTEN", { timestamp: data.timestamp });
        } catch (err) {
            console.error("MMM-EcoFlow: Atomic write failed", {
                targetPath: targetPath,
                tmpPath: tmpPath,
                error: err
            });
            // Aufräumen falls tmp verwaist ist
            if (fs.existsSync(tmpPath)) {
                try { fs.unlinkSync(tmpPath); } catch (_) {}
            }
        }
    }
});
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

        const signature = this.generateSignature(params, this.config.secretKey);
        const certUrl = `${this.config.apiUrl}/iot-open/sign/certification`;

        try {
            this.sendSocketNotification("STATUS_UPDATE", { status: "Authenticating..." });
            
            const response = await axios.get(certUrl, {
                headers: {
                    "accessKey": this.config.accessKey,
                    "nonce": nonce,
                    "timestamp": timestamp,
                    "sign": signature
                }
            });

            if (response.data && response.data.code === "0" && response.data.data) {
                this.connectMQTT(response.data.data);
            } else {
                let msg = response.data ? response.data.message : "Unknown Error";
                this.sendSocketNotification("STATUS_UPDATE", { status: `API Error: ${msg}` });
            }
        } catch (error) {
            console.error("MMM-EcoFlow: Error fetching certification", error);
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

        this.mqttClient = mqtt.connect(brokerUrl, options);

        this.mqttClient.on("connect", () => {
            self.sendSocketNotification("STATUS_UPDATE", { status: "Connected to MQTT" });
            
            // Abonnieren der konfigurierten Topics
            if (Array.isArray(self.config.topics)) {
                self.config.topics.forEach(topic => {
                    self.mqttClient.subscribe(topic, (err) => {
                        if (!err) console.log(`MMM-EcoFlow: Subscribed to ${topic}`);
                    });
                });
            }
        });

        this.mqttClient.on("message", (topic, message) => {
            self.processMessage(message.toString());
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
    processMessage: function(rawMessage) {
        try {
            const parsed = JSON.parse(rawMessage);
            
            // Filter anwenden
            let extractedData = this.filterObject(parsed, this.config.dataFilter);
            
            // Timestamp ermitteln und konvertieren
            // EcoFlow liefert oft 'timestamp' oder innerhalb von 'param' bzw. 'data'
            let rawTime = parsed.timestamp || (parsed.data && parsed.data.timestamp) || null;
            const formattedTime = this.formatTimestamp(rawTime);
            
            // Output-Objekt strukturieren
            const outputPayload = {
                timestamp: formattedTime,
                data: extractedData
            };

            this.writeAtomicJSON(outputPayload);
        } catch (e) {
            console.error("MMM-EcoFlow: Error processing MQTT payload", e);
        }
    },

    // Garantiert atomarer Schreibprozess über POSIX renameSync
    writeAtomicJSON: function(data) {
        const targetPath = path.resolve(this.config.outputFile);
        const tmpPath = targetPath + ".tmp";

        try {
            // Ordnerstruktur erstellen, falls sie nicht existiert
            const dir = path.dirname(targetPath);
            if (!fs.existsSync(dir)){
                fs.mkdirSync(dir, { recursive: true });
            }

            // 1. In die .tmp Datei schreiben
            fs.writeFileSync(tmpPath, JSON.stringify(data, null, 4), "utf8");
            
            // 2. Atomares Ersetzen im OS-Dateisystem (Linux rename)
            fs.renameSync(tmpPath, targetPath);

            // Erfolg zurück an das Frontend senden
            this.sendSocketNotification("DATA_WRITTEN", { timestamp: data.timestamp });
        } catch (err) {
            console.error("MMM-EcoFlow: Atomic write failed", err);
            // Aufräumen falls tmp verwaist ist
            if (fs.existsSync(tmpPath)) {
                try { fs.unlinkSync(tmpPath); } catch (_) {}
            }
        }
    }
});
const NodeHelper = require("node_helper");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const mqtt = require("mqtt");

module.exports = NodeHelper.create({
  start: function () {
    console.log("MMM-EcoFlow helper started...");
    this.mqttClient = null;
    this.config = null;
    this.lastKnownValues = {};
    this.flushIntervalMs = 60000;
    this.pendingData = null;
    this.pendingFlushTimeout = null;
    // State for daily energy calculation
    this.energyState = {
      currentDay: null, // YYYY-MM-DD
      totalKWh: 0,
    };
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "CONFIG") {
      this.config = payload;
      this.flushIntervalMs = this.normalizeUpdateInterval(
        payload.updateInterval,
      );
      this.lastKnownValues = {};
      this.pendingData = null;

      if (this.pendingFlushTimeout) {
        clearTimeout(this.pendingFlushTimeout);
        this.pendingFlushTimeout = null;
      }

      console.log("MMM-EcoFlow: CONFIG received", {
        accessKey: payload.accessKey ? "present" : "missing",
        secretKey: payload.secretKey ? "present" : "missing",
        topics: Array.isArray(payload.topics) ? payload.topics : [],
        dataFilter: Array.isArray(payload.dataFilter) ? payload.dataFilter : [],
        outputFile: payload.outputFile,
        maxHistoryEntries: payload.maxHistoryEntries,
        apiUrl: payload.apiUrl,
        updateInterval: this.flushIntervalMs,
      });
      this.initEcoFlowConnection();
      // Recover energy state from existing history file (if enabled)
      try {
        const targetPath = path.resolve(this.config.outputFile);
        if (this.config && this.config.calcDailyEnergy) {
          this.recoverEnergyStateFromHistory(targetPath);
        }
      } catch (e) {
        console.error("MMM-EcoFlow: Failed to recover energy state", e);
      }
    }
  },

  // EcoFlow Signature Generator (nach offizieller Developer Dokumentation)
  generateSignature: function (params, secretKey) {
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

  normalizeApiUrl: function (apiUrl) {
    if (!apiUrl) {
      return "https://api.ecoflow.com";
    }

    return apiUrl
      .replace(
        /^https?:\/\/developer-eu\.ecoflow\.com/i,
        "https://api.ecoflow.com",
      )
      .replace(/^https?:\/\/api-eu\.ecoflow\.com/i, "https://api.ecoflow.com");
  },

  normalizeUpdateInterval: function (rawValue) {
    const parsed = Number(rawValue);

    if (!Number.isFinite(parsed)) {
      return 60000;
    }

    if (parsed <= 0) {
      return 0;
    }

    return Math.max(0, parsed);
  },

  scheduleBufferedWrite: function (data) {
    if (this.flushIntervalMs === 0) {
      this.writeAtomicJSON(data);
      return;
    }

    // Buffer the latest data record
    this.pendingData = data;
    console.log(
      "MMM-EcoFlow: scheduleBufferedWrite() - data buffered. Will flush in ms:",
      this.flushIntervalMs,
      "payload-preview:",
      JSON.stringify(data).slice(0, 160),
    );

    if (this.pendingFlushTimeout) {
      console.log(
        "MMM-EcoFlow: scheduleBufferedWrite() - flush timer already pending, keeping existing timer",
      );
      return;
    }

    // Use a named reference so we can log when it fires
    this.pendingFlushTimeout = setTimeout(() => {
      try {
        console.log(
          "MMM-EcoFlow: Flush timer fired. pendingData present:",
          !!this.pendingData,
        );
        if (this.pendingData) {
          console.log(
            "MMM-EcoFlow: Invoking writeAtomicJSON from flush timer. Preview:",
            JSON.stringify(this.pendingData).slice(0, 160),
          );
          this.writeAtomicJSON(this.pendingData);
          this.pendingData = null;
        } else {
          console.log(
            "MMM-EcoFlow: Flush timer fired but no pendingData to write.",
          );
        }
      } catch (err) {
        console.error("MMM-EcoFlow: Error during flush timer handler", err);
      }
      this.pendingFlushTimeout = null;
    }, this.flushIntervalMs);
  },

  // Holt die Broker-Verbindungsdaten von der EcoFlow API
  initEcoFlowConnection: async function () {
    const self = this;
    const nonce = Math.floor(Math.random() * 1000000).toString();
    const timestamp = Date.now().toString();

    const params = {
      accessKey: this.config.accessKey,
      nonce: nonce,
      timestamp: timestamp,
    };

    this.config.apiUrl = this.normalizeApiUrl(this.config.apiUrl);
    const signature = this.generateSignature(params, this.config.secretKey);
    const certUrl = `${this.config.apiUrl}/iot-open/sign/certification`;

    try {
      console.log("MMM-EcoFlow: Requesting certification from", certUrl);
      this.sendSocketNotification("STATUS_UPDATE", {
        status: "Authenticating...",
      });

      const response = await axios.get(certUrl, {
        headers: {
          accessKey: this.config.accessKey,
          nonce: nonce,
          timestamp: timestamp,
          sign: signature,
        },
      });

      const responseData = response.data;
      const responseIsHtml =
        typeof responseData === "string" &&
        responseData.trim().startsWith("<!doctype html");

      console.log("MMM-EcoFlow: certification response OK", {
        status: response.status,
        code: responseData && responseData.code,
        message: responseData && responseData.message,
        mqttHost: responseData && responseData.data && responseData.data.url,
        mqttPort: responseData && responseData.data && responseData.data.port,
        protocol:
          responseData && responseData.data && responseData.data.protocol,
      });

      if (responseIsHtml) {
        console.error(
          "MMM-EcoFlow: API endpoint returned HTML instead of JSON. Check apiUrl.",
          {
            certUrl: certUrl,
            expected: "https://api-eu.ecoflow.com",
          },
        );
        this.sendSocketNotification("STATUS_UPDATE", {
          status: "Endpoint mismatch: use https://api-eu.ecoflow.com",
        });
        return;
      }

      if (responseData && responseData.code === "0" && responseData.data) {
        this.connectMQTT(responseData.data);
      } else {
        let msg =
          responseData && responseData.message
            ? responseData.message
            : "Unknown Error";
        console.error("MMM-EcoFlow: API returned non-zero code", responseData);
        this.sendSocketNotification("STATUS_UPDATE", {
          status: `API Error: ${msg}`,
        });
      }
    } catch (error) {
      console.error("MMM-EcoFlow: Error fetching certification", {
        message: error.message,
        responseStatus: error.response && error.response.status,
        responseData: error.response && error.response.data,
      });
      this.sendSocketNotification("STATUS_UPDATE", {
        status: "Connection Failed",
      });
    }
  },

  // Erstellt die MQTT-Verbindung mit den erhaltenen Zertifikaten
  resolveTopics: function (authData) {
    if (!Array.isArray(this.config.topics)) {
      return [];
    }

    const certificateAccount =
      authData.certificateAccount || authData.username || "";
    const serialNumber = this.config.deviceSerial || this.config.sn || "";

    return this.config.topics.map((topic) => {
      return topic
        .replace(/\$\{certificateAccount\}/g, certificateAccount)
        .replace(/\$\{sn\}/g, serialNumber)
        .replace(/\$\{serial\}/g, serialNumber)
        .replace(/\$\{deviceSerial\}/g, serialNumber);
    });
  },

  connectMQTT: function (authData) {
    const self = this;
    const brokerUrl = `mqtts://${authData.url}:${authData.port}`;
    const username = authData.certificateAccount || authData.username;
    const password = authData.certificatePassword || authData.password;
    const clientId =
      authData.certificateAccount ||
      authData.clientId ||
      `ecoflow-${Date.now()}`;

    const options = {
      clientId: clientId,
      username: username,
      password: password,
      keepalive: 60,
      reconnectPeriod: 10000,
      rejectUnauthorized: true,
    };

    console.log("MMM-EcoFlow: Connecting MQTT broker", {
      brokerUrl: brokerUrl,
      clientId: clientId,
      username: username,
      password: password ? "present" : "missing",
    });

    this.mqttClient = mqtt.connect(brokerUrl, options);

    this.mqttClient.on("connect", () => {
      console.log("MMM-EcoFlow: MQTT connection established");
      self.sendSocketNotification("STATUS_UPDATE", {
        status: "Connected to MQTT. Subscribing...",
      });

      // Abonnieren der konfigurierten Topics
      const topics = self.resolveTopics(authData);
      if (topics.length > 0) {
        let subscribedCount = 0;
        topics.forEach((topic) => {
          self.mqttClient.subscribe(topic, (err) => {
            if (err) {
              console.error(
                "MMM-EcoFlow: MQTT subscribe failed for",
                topic,
                err,
              );
            } else {
              subscribedCount++;
              console.log(`MMM-EcoFlow: Subscribed to ${topic}`);

              if (subscribedCount === topics.length) {
                console.log(
                  `MMM-EcoFlow: All ${topics.length} topics subscribed. Waiting for live data.`,
                );
                self.sendSocketNotification("STATUS_UPDATE", {
                  status: `Connected to MQTT (${topics.length} topics). Waiting for live data...`,
                });
              }
            }
          });
        });
      } else {
        console.error(
          "MMM-EcoFlow: No topics configured for MQTT subscription",
        );
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

  // Konvertiert Timestamps in das Format DD.MM.YYYY HH:MM:SS
  // Für neue MQTT-Daten wird die lokale Systemzeit des Rechners verwendet.
  formatTimestamp: function (apiTimestamp) {
    const timestampValue = Number(apiTimestamp);
    const rawDate = Number.isFinite(timestampValue)
      ? new Date(timestampValue)
      : new Date();
    const date = Number.isNaN(rawDate.getTime()) ? new Date() : rawDate;
    const pad = (n) => String(n).padStart(2, "0");

    const day = pad(date.getDate());
    const month = pad(date.getMonth() + 1);
    const year = date.getFullYear();
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());

    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
  },

  // Parse timestamp in format DD.MM.YYYY HH:MM:SS to ms since epoch
  parseFormattedTimestampMs: function (formatted) {
    if (!formatted || typeof formatted !== "string") return null;
    // Expect DD.MM.YYYY HH:MM:SS
    const parts = formatted.split(" ");
    if (parts.length < 2) return null;
    const dateParts = parts[0].split(".");
    const timeParts = parts[1].split(":");
    if (dateParts.length !== 3 || timeParts.length !== 3) return null;
    const day = Number(dateParts[0]);
    const month = Number(dateParts[1]) - 1;
    const year = Number(dateParts[2]);
    const hours = Number(timeParts[0]);
    const minutes = Number(timeParts[1]);
    const seconds = Number(timeParts[2]);
    const dt = new Date(year, month, day, hours, minutes, seconds);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.getTime();
  },

  // Compute energy contribution between two records (kWh)
  computeEnergyBetween: function (prev, curr) {
    try {
      const prevMs = prev.timestampMs || this.parseFormattedTimestampMs(prev.timestamp);
      const currMs = curr.timestampMs || this.parseFormattedTimestampMs(curr.timestamp);
      if (!prevMs || !currMs || currMs <= prevMs) return 0;
      const deltaHours = (currMs - prevMs) / 3600000;

      const prevPower = Number(prev.gridConnectionPower || 0);
      const currPower = Number(curr.gridConnectionPower || prevPower || 0);

      // Use trapezoidal rule (average power) for better accuracy
      const avgPower = (prevPower + currPower) / 2;
      const energyKWh = (avgPower * deltaHours) / 1000.0;
      return energyKWh > 0 ? energyKWh : 0;
    } catch (e) {
      return 0;
    }
  },

  // Recover energy state from existing history file so daily total continues
  recoverEnergyStateFromHistory: function (targetPath) {
    const today = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

    const history = this.loadExistingDataHistory(targetPath);
    if (!Array.isArray(history) || history.length === 0) {
      this.energyState.currentDay = todayKey;
      this.energyState.totalKWh = 0;
      return;
    }

    // Ensure entries are sorted ascending by timestamp
    const entries = history
      .map((e) => {
        const ms = e.timestampMs || this.parseFormattedTimestampMs(e.timestamp);
        return { entry: e, ms: ms || 0 };
      })
      .sort((a, b) => a.ms - b.ms)
      .map((x) => x.entry);

    // Sum energy only for intervals that fall into today's date
    let total = 0;
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const curr = entries[i];
      const currMs = curr.timestampMs || this.parseFormattedTimestampMs(curr.timestamp);
      const dt = new Date(currMs);
      const pad2 = (n) => String(n).padStart(2, "0");
      const key = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
      if (key === todayKey) {
        total += this.computeEnergyBetween(prev, curr);
      }
    }

    this.energyState.currentDay = todayKey;
    this.energyState.totalKWh = Number(total.toFixed(6));
    console.log("MMM-EcoFlow: Recovered daily energy (kWh)", this.energyState.totalKWh);
  },

  // Rekursive Filterfunktion für verschachtelte JSON-Objekte
  filterObject: function (obj, allowedKeys) {
    if (!Array.isArray(allowedKeys) || allowedKeys.length === 0) return obj;

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

  mergeWithLastKnownValues: function (currentData) {
    if (!this.config) {
      return currentData;
    }

    const targetKeys =
      Array.isArray(this.config.dataFilter) && this.config.dataFilter.length > 0
        ? this.config.dataFilter
        : Object.keys(currentData);

    const merged = { ...this.lastKnownValues };

    targetKeys.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(currentData, key)) {
        merged[key] = currentData[key];
      }
    });

    this.lastKnownValues = { ...merged };
    return { ...merged };
  },

  // Verarbeitet die eingehenden MQTT-Pakete, filtert und schreibt sie atomar
  processMessage: function (topic, rawMessage) {
    try {
      const parsed = JSON.parse(rawMessage);
      const preview = JSON.stringify(parsed).slice(0, 160);

      // Filter anwenden
      let extractedData = this.filterObject(parsed, this.config.dataFilter);
      const filteredKeys = Object.keys(extractedData);

      // Neue Datensätze werden mit der lokalen Systemzeit des Rechners
      // versehen, sobald sie im MQTT-Stream ankommen.
      const formattedTime = this.formatTimestamp(Date.now());

      console.log(
        `MMM-EcoFlow: MQTT payload preview for ${topic}: ${preview}${preview.length >= 160 ? "..." : ""}`,
      );
      console.log(
        `MMM-EcoFlow: Filtered payload keys (${filteredKeys.length})`,
        filteredKeys,
      );

      if (filteredKeys.length === 0) {
        console.log(
          "MMM-EcoFlow: Skipping record with no matching filtered data keys.",
        );
        return;
      }

      const mergedData = this.mergeWithLastKnownValues(extractedData);

      console.log(
        "MMM-EcoFlow: Merged data (after carry-forward):",
        JSON.stringify(mergedData).slice(0, 160),
      );
      console.log("MMM-EcoFlow: Using timestamp:", formattedTime);

      // Output-Objekt strukturieren - flat array record format for downstream charting
      const outputPayload = {
        timestamp: formattedTime,
        topic: topic,
        ...mergedData,
      };

      this.scheduleBufferedWrite(outputPayload);
    } catch (e) {
      console.error("MMM-EcoFlow: Error processing MQTT payload", {
        topic: topic,
        error: e,
      });
    }
  },

  normalizeHistoryRecord: function (entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    if (entry.timestamp && entry.data && typeof entry.data === "object") {
      return {
        timestamp: entry.timestamp,
        topic: entry.topic || null,
        ...entry.data,
      };
    }

    if (entry.timestamp) {
      return {
        ...entry,
        topic: entry.topic || null,
      };
    }

    return null;
  },

  loadExistingDataHistory: function (targetPath) {
    if (!fs.existsSync(targetPath)) {
      return [];
    }

    try {
      const raw = fs.readFileSync(targetPath, "utf8");
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => this.normalizeHistoryRecord(entry))
          .filter(Boolean);
      }

      const normalized = this.normalizeHistoryRecord(parsed);
      return normalized ? [normalized] : [];
    } catch (err) {
      console.error("MMM-EcoFlow: Failed to read existing history file", {
        targetPath: targetPath,
        error: err,
      });
      return [];
    }
  },

  normalizeMaxHistoryEntries: function (value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }

    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.floor(parsed);
      }
    }

    return Infinity;
  },

  trimHistoryToLimit: function (history, maxEntries) {
    if (!Array.isArray(history)) {
      return [];
    }

    if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
      return history;
    }

    if (history.length <= maxEntries) {
      return history;
    }

    return history.slice(history.length - maxEntries);
  },

  // Garantiert atomarer Schreibprozess über POSIX renameSync
  writeAtomicJSON: function (data) {
    const targetPath = path.resolve(this.config.outputFile);
    const tmpPath = targetPath + ".tmp";

    try {
      console.log("MMM-EcoFlow: Writing output to", targetPath);

      // Ordnerstruktur erstellen, falls sie nicht existiert
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        console.log("MMM-EcoFlow: Creating output directory", dir);
        fs.mkdirSync(dir, { recursive: true });
      }

      const history = this.loadExistingDataHistory(targetPath);
      const maxHistoryEntries = this.normalizeMaxHistoryEntries(
        this.config && this.config.maxHistoryEntries,
      );
      const previousEntry = history[history.length - 1];
      const isDuplicate =
        previousEntry && JSON.stringify(previousEntry) === JSON.stringify(data);

      if (isDuplicate) {
        console.log("MMM-EcoFlow: Skipping duplicate data record.");
        return;
      }

      const latestHistoryEntry = history[history.length - 1];
      if (
        latestHistoryEntry &&
        latestHistoryEntry.timestamp &&
        this.config &&
        Array.isArray(this.config.dataFilter) &&
        this.config.dataFilter.length > 0
      ) {
        this.config.dataFilter.forEach((key) => {
          if (
            typeof latestHistoryEntry[key] !== "undefined" &&
            typeof data[key] === "undefined"
          ) {
            data[key] = latestHistoryEntry[key];
          }
        });
      }

      // If configured, compute daily energy (kWh) using gridConnectionPower and delta time
      let recordToWrite = { ...data };
      if (this.config && this.config.calcDailyEnergy) {
        try {
          const currMs = this.parseFormattedTimestampMs(data.timestamp) || Date.now();

          const pad = (n) => String(n).padStart(2, "0");
          const dt = new Date(currMs);
          const dayKey = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;

          if (this.energyState.currentDay !== dayKey) {
            // New day -> reset
            this.energyState.currentDay = dayKey;
            this.energyState.totalKWh = 0;
          }

          let energyAdded = 0;
          if (latestHistoryEntry) {
            energyAdded = this.computeEnergyBetween(latestHistoryEntry, data);
          }

          if (energyAdded > 0) {
            this.energyState.totalKWh = Number((this.energyState.totalKWh + energyAdded).toFixed(6));
          }

          // Only expose a single field `energyToday` in the written record.
          // Keep other internal fields (timestampMs, energyInterval_kWh) out of the output.
          // Prepare the record that will be stored in history and written to file.
          recordToWrite = { ...data };
          delete recordToWrite.timestampMs;
          delete recordToWrite.energyInterval_kWh;
          recordToWrite.energyToday = Number(this.energyState.totalKWh.toFixed(3));
        } catch (e) {
          console.error("MMM-EcoFlow: Error computing daily energy", e);
          recordToWrite = { ...data };
          delete recordToWrite.timestampMs;
          delete recordToWrite.energyInterval_kWh;
        }
      } else {
        // If not calculating energy, ensure internal fields are not written
        recordToWrite = { ...data };
        delete recordToWrite.timestampMs;
        delete recordToWrite.energyInterval_kWh;
      }

      history.push(recordToWrite);
      const boundedHistory = this.trimHistoryToLimit(
        history,
        maxHistoryEntries,
      );

      // 1. In die .tmp Datei schreiben
      fs.writeFileSync(
        tmpPath,
        JSON.stringify(boundedHistory, null, 4),
        "utf8",
      );

      // 2. Atomares Ersetzen im OS-Dateisystem (Linux rename)
      fs.renameSync(tmpPath, targetPath);

      console.log("MMM-EcoFlow: JSON file successfully written", targetPath);

      // Erfolg zurück an das Frontend senden
      this.sendSocketNotification("DATA_WRITTEN", {
        timestamp: data.timestamp,
        receivedAt: Date.now(),
        entryCount: boundedHistory.length,
      });
    } catch (err) {
      console.error("MMM-EcoFlow: Atomic write failed", {
        targetPath: targetPath,
        tmpPath: tmpPath,
        error: err,
      });
      // Aufräumen falls tmp verwaist ist
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch (_) {}
      }
    }
  },
});

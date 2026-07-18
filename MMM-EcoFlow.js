Module.register("MMM-EcoFlow", {
    defaults: {
        accessKey: "",
        secretKey: "",
        topics: [], // Array von Topics, z.B. ["/open/api/device/quota/v1/DEINE_SERIENNUMMER"]
        dataFilter: [], // Array von Keys, die behalten werden sollen (z.B. ["soc", "wIn", "wOut"])
        outputFile: "modules/MMM-EcoFlow/output.json",
        apiUrl: "https://api.ecoflow.com", // Documented EcoFlow API host
        showModule: true
    },

    start: function() {
        Log.info("Starting module: " + this.name);
        this.status = "Initializing...";
        this.lastUpdate = "Never";
        this.entryCount = 0;
        this.lastReceivedAt = null;
        this.hidden = this.config && typeof this.config.showModule === "boolean"
            ? !this.config.showModule
            : false;
        
        // Konfiguration an den Node-Helper senden
        this.sendSocketNotification("CONFIG", this.config);
    },

    getStyles: function() {
        return ["MMM-EcoFlow.css"];
    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === "STATUS_UPDATE") {
            this.status = payload.status;
            this.updateDom();
        } else if (notification === "DATA_WRITTEN") {
            this.status = "Connected & Writing";
            this.lastUpdate = payload.timestamp;
            this.lastReceivedAt = payload.receivedAt || Date.now();
            this.entryCount = payload.entryCount || 0;
            this.updateDom();
        }
    },

    formatRelativeTime: function(timestampMs) {
        if (!timestampMs || Number.isNaN(timestampMs)) {
            return "Never";
        }

        const diffMs = Date.now() - timestampMs;
        const diffSec = Math.max(0, Math.floor(diffMs / 1000));

        if (diffSec < 60) {
            return `${diffSec}s ago`;
        }

        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) {
            return `${diffMin}min ago`;
        }

        const diffHours = Math.floor(diffMin / 60);
        if (diffHours < 24) {
            return `${diffHours}h ago`;
        }

        const diffDays = Math.floor(diffHours / 24);
        return `${diffDays}d ago`;
    },

    getDom: function() {
        if (this.hidden) {
            return document.createElement("div");
        }

        const wrapper = document.createElement("div");
        wrapper.className = "ecoflow-wrapper small";

        const title = document.createElement("div");
        title.className = "ecoflow-title bold";
        title.innerHTML = "EcoFlow API Bridge";
        wrapper.appendChild(title);

        const statusDiv = document.createElement("div");
        statusDiv.innerHTML = "<span class='dimmed'>Status:</span> " + this.status;
        wrapper.appendChild(statusDiv);

        const updateDiv = document.createElement("div");
        const relativeTime = this.lastReceivedAt ? this.formatRelativeTime(this.lastReceivedAt) : this.lastUpdate;
        const totalLabel = this.entryCount > 0 ? ` (${this.entryCount} entries total)` : "";
        updateDiv.innerHTML = "<span class='dimmed'>Last Data:</span> " + relativeTime + totalLabel;
        wrapper.appendChild(updateDiv);

        return wrapper;
    }
});
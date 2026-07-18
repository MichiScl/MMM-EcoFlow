Module.register("MMM-EcoFlow", {
    defaults: {
        accessKey: "",
        secretKey: "",
        topics: [], // Array von Topics, z.B. ["/open/api/device/quota/v1/DEINE_SERIENNUMMER"]
        dataFilter: [], // Array von Keys, die behalten werden sollen (z.B. ["soc", "wIn", "wOut"])
        outputFile: "modules/MMM-EcoFlow/output.json",
        apiUrl: "https://api-eu.ecoflow.com", // Standard EU Endpoint
        showModule: true
    },

    start: function() {
        Log.info("Starting module: " + this.name);
        this.status = "Initializing...";
        this.lastUpdate = "Never";
        this.hidden = !this.config.showModule;
        
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
            this.updateDom();
        }
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
        updateDiv.innerHTML = "<span class='dimmed'>Last Data:</span> " + this.lastUpdate;
        wrapper.appendChild(updateDiv);

        return wrapper;
    }
});
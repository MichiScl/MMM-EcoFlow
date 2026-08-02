function normalizeMaxHistoryEntries(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }

    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) {
            return Math.floor(parsed);
        }
    }

    return Infinity;
}

function trimHistoryToLimit(history, maxEntries) {
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
}

module.exports = {
    normalizeMaxHistoryEntries,
    trimHistoryToLimit
};

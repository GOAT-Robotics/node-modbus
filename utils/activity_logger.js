"use strict";

const LOG_PREFIX = "modbus-lib:";
const LEVELS = {
    debug: "debug",
    info: "info",
    warn: "warn",
    error: "error"
};

function formatValue(value) {
    if (typeof value === "undefined") return "";
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return String(value);
    try {
        return JSON.stringify(value);
    } catch (e) {
        return String(value);
    }
}

function formatDetails(details) {
    if (!details || typeof details !== "object" || Array.isArray(details)) {
        return formatValue(details);
    }

    const parts = [];
    Object.keys(details).forEach((key) => {
        const value = details[key];
        if (typeof value === "undefined") return;
        parts.push(`${key}=${formatValue(value)}`);
    });
    return parts.join(" | ");
}

function createActivityLogger(scope, sink, options) {
    options = options || {};
    let sinkObject = console;
    if (sink && typeof sink === "object") {
        sinkObject = sink;
    }
    let sinkFunction = null;
    if (typeof sink === "function") {
        sinkFunction = sink;
    }

    let isEnabled = options.enabled;
    if (typeof isEnabled === "undefined") {
        isEnabled = false;
    }
    const label = scope || "activity";

    function getWriter(level) {
        if (sinkFunction) {
            return sinkFunction;
        }
        if (sinkObject && typeof sinkObject[level] === "function") {
            return sinkObject[level].bind(sinkObject);
        }
        return console.log;
    }

    function isLibraryLogEnabled() {
        if (typeof isEnabled === "function") {
            return Boolean(isEnabled());
        }
        return Boolean(isEnabled);
    }

    function log(levelOrEvent, eventOrDetails, maybeDetails) {
        if (!isLibraryLogEnabled()) return;

        let level = LEVELS.info;
        let event = levelOrEvent;
        let details = eventOrDetails;

        if (LEVELS[levelOrEvent]) {
            level = levelOrEvent;
            event = eventOrDetails;
            details = maybeDetails;
        }

        const timestamp = new Date().toISOString();
        const levelTag = level.toUpperCase();
        let message = `${timestamp} | ${LOG_PREFIX} | [${levelTag}] | ${label} | ${event}`;
        const write = getWriter(level);
        if (typeof details !== "undefined") {
            const detailsText = formatDetails(details);
            if (detailsText.length > 0) {
                message += ` | ${detailsText}`;
            }
        }
        write(message);
    }

    log.debug = function(event, details) {
        log(LEVELS.debug, event, details);
    };
    log.info = function(event, details) {
        log(LEVELS.info, event, details);
    };
    log.warn = function(event, details) {
        log(LEVELS.warn, event, details);
    };
    log.error = function(event, details) {
        log(LEVELS.error, event, details);
    };
    log.isEnabled = isLibraryLogEnabled;

    return log;
}

module.exports = createActivityLogger;

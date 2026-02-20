"use strict";
const events = require("events");
const EventEmitter = events.EventEmitter || events;
const net = require("net");
const modbusSerialDebug = require("debug")("modbus-serial");

const crc16 = require("../utils/crc16");
const createActivityLogger = require("../utils/activity_logger");

/* TODO: const should be set once, maybe */
const EXCEPTION_LENGTH = 3;
const MIN_DATA_LENGTH = 6;
const MIN_MBAP_LENGTH = 6;
const MAX_TRANSACTIONS = 64; // maximum transaction to wait for
const MAX_BUFFER_LENGTH = 256;
const CRC_LENGTH = 2;

const MODBUS_PORT = 502;

function normalizeAutoReconnect(options) {
    if (!options) return null;
    if (options === true) {
        return { maxRetries: Infinity, minDelay: 1000, maxDelay: 30000, backoffFactor: 1.5 };
    }
    if (options === false) return null;
    if (typeof options !== "object" || Array.isArray(options)) return null;

    let maxRetries = Infinity;
    let minDelay = 1000;
    let maxDelay = 30000;
    let backoffFactor = 1.5;

    if (typeof options.maxRetries === "number" && Number.isFinite(options.maxRetries)) {
        maxRetries = Math.max(0, Math.floor(options.maxRetries));
    }
    if (typeof options.minDelay === "number" && Number.isFinite(options.minDelay) && options.minDelay > 0) {
        minDelay = options.minDelay;
    }
    if (typeof options.maxDelay === "number" && Number.isFinite(options.maxDelay) && options.maxDelay > 0) {
        maxDelay = options.maxDelay;
    }
    if (typeof options.backoffFactor === "number" && Number.isFinite(options.backoffFactor) && options.backoffFactor > 0) {
        backoffFactor = options.backoffFactor;
    }

    // Ensure maxDelay >= minDelay
    if (maxDelay < minDelay) {
        maxDelay = minDelay;
    }

    return { maxRetries, minDelay, maxDelay, backoffFactor };
}

class TcpRTUBufferedPort extends EventEmitter {
    /**
     * Simulate a modbus-RTU port using TCP connection
     * @module TcpRTUBufferedPort
     *
     * @param {string} ip - ip address
     * @param {object} options - all options as JSON object
     *   options.port: Nonstandard Modbus port (default is 502).
     *   options.localAddress: Local IP address to bind to, default is any.
     *   options.family: 4 = IPv4-only, 6 = IPv6-only, 0 = either (default).
     * @constructor
     */
    constructor(ip, options) {
        super();

        const modbus = this;
        modbus.openFlag = false;
        modbus.callback = null;
        modbus._transactionIdWrite = 1;
        this._externalSocket = null;
        this._closing = false;
        this._reconnectTimer = null;
        this._reconnectAttempt = 0;
        this._reconnecting = false;
        this._lastError = null;
        this._autoReconnect = null;
        this._socketTimeout = null;
        this._hadConnected = false;
        this._keepAlive = null;
        this._keepAliveInitialDelay = 1000;
        this._activityLog = null;
        this._connectionStats = {
            attempts: 0,
            successes: 0,
            failures: 0
        };
        this._connectInFlight = false;

        // options
        if(typeof ip === "object") {
            options = ip;
        }
        if (typeof options === "undefined") options = {};
        const modbusLogEnabled = Boolean(options.modbusLogEnabled);
        delete options.modbusLogEnabled;
        this._activityLog = createActivityLogger("tcp-rtu-buffered-port", null, { enabled: modbusLogEnabled });

        const reconnectOptions = options.autoReconnect ?? options.reconnect;
        delete options.autoReconnect;
        delete options.reconnect;

        if (typeof options.keepAlive !== "undefined") {
            this._keepAlive = Boolean(options.keepAlive);
            delete options.keepAlive;
        }
        if (typeof options.keepAliveInitialDelay === "number") {
            this._keepAliveInitialDelay = options.keepAliveInitialDelay;
            delete options.keepAliveInitialDelay;
        }

        if (typeof options.timeout === "number") {
            this._socketTimeout = options.timeout;
        }

        modbus.connectOptions = {
            host: ip || options.ip,
            port: options.port || MODBUS_PORT,
            localAddress: options.localAddress,
            family: options.family || 0
        };

        this._autoReconnect = normalizeAutoReconnect(reconnectOptions);
        if (this._keepAlive === null) {
            if (this._autoReconnect) {
                this._keepAlive = true;
            } else {
                this._keepAlive = false;
            }
        }

        if(options.socket) {
            if(options.socket instanceof net.Socket) {
                this._externalSocket = options.socket;
                this.openFlag = this._externalSocket.readyState === "opening" || this._externalSocket.readyState === "open";
            } else {
                throw new Error("invalid socket provided");
            }
        }

        // internal buffer
        modbus._buffer = Buffer.alloc(0);

        // create a socket
        modbus._client = this._externalSocket || new net.Socket();
        if (this._socketTimeout) this._client.setTimeout(this._socketTimeout);

        // bind handlers once so we can re-attach them on reconnect
        this._handleSocketData = function(data) {
            // add data to buffer
            modbus._buffer = Buffer.concat([modbus._buffer, data]);

            modbusSerialDebug({
                action: "receive tcp rtu buffered port",
                data: data,
                buffer: modbus._buffer
            });

            // check if buffer include a complete modbus answer
            let bufferLength = modbus._buffer.length;

            // check data length
            if (bufferLength < MIN_MBAP_LENGTH) return;

            // check buffer size for MAX_BUFFER_SIZE
            if (bufferLength > MAX_BUFFER_LENGTH) {
                modbus._buffer = modbus._buffer.slice(-MAX_BUFFER_LENGTH);
                bufferLength = MAX_BUFFER_LENGTH;
            }

            // check data length
            if (bufferLength < MIN_MBAP_LENGTH + EXCEPTION_LENGTH) return;

            // loop and check length-sized buffer chunks
            const maxOffset = bufferLength - MIN_MBAP_LENGTH;
            for (let i = 0; i <= maxOffset; i++) {
                modbus._transactionIdRead = modbus._buffer.readUInt16BE(i);
                const protocolID = modbus._buffer.readUInt16BE(i + 2);
                const msgLength = modbus._buffer.readUInt16BE(i + 4);
                const cmd = modbus._buffer[i + 7];

                modbusSerialDebug({
                    protocolID: protocolID,
                    msgLength: msgLength,
                    bufferLength: bufferLength,
                    cmd: cmd
                });

                if (
                    protocolID === 0 &&
                    cmd !== 0 &&
                    msgLength >= EXCEPTION_LENGTH &&
                    i + MIN_MBAP_LENGTH + msgLength <= bufferLength
                ) {
                    // add crc and emit
                    modbus._emitData(i + MIN_MBAP_LENGTH, msgLength);
                    return;
                }
            }
        };

        this._handleSocketConnect = function() {
            const wasReconnecting = modbus._reconnecting;
            const reconnectAttempt = modbus._reconnectAttempt;
            modbus.openFlag = true;
            modbus._hadConnected = true;
            modbus._reconnecting = false;
            modbus._lastError = null;
            modbus._connectInFlight = false;
            modbus._connectionStats.successes += 1;
            if (modbus._reconnectTimer) {
                clearTimeout(modbus._reconnectTimer);
                modbus._reconnectTimer = null;
            }
            if (modbus._keepAlive && typeof modbus._client.setKeepAlive === "function") {
                modbus._client.setKeepAlive(true, modbus._keepAliveInitialDelay);
            }
            modbus._activityLog("info", "tcp connected", {
                ...modbus._getEndpointDetails(),
                ...modbus._getConnectionRatioDetails()
            });
            modbus._safeEmit("connect");
            if (wasReconnecting) {
                modbus._safeEmit("reconnect", reconnectAttempt);
            }
            modbus._handleCallback();
        };

        this._handleSocketClose = function(had_error) {
            const wasOpen = modbus.openFlag;
            modbus.openFlag = false;
            modbusSerialDebug("TCP buffered port: signal close: " + had_error);
            let lastErrorMessage;
            if (modbus._lastError && modbus._lastError.message) {
                lastErrorMessage = modbus._lastError.message;
            }
            if (had_error) {
                if (modbus._connectInFlight) {
                    modbus._connectionStats.failures += 1;
                    modbus._connectInFlight = false;
                }
                modbus._activityLog("warn", "tcp disconnected", {
                    ...modbus._getEndpointDetails(),
                    ...modbus._getConnectionRatioDetails(),
                    hadError: Boolean(had_error),
                    error: lastErrorMessage
                });
            } else {
                modbus._activityLog("info", "tcp disconnected", {
                    ...modbus._getEndpointDetails(),
                    ...modbus._getConnectionRatioDetails(),
                    hadError: Boolean(had_error),
                    error: lastErrorMessage
                });
            }
            let closeError = modbus._lastError;
            if (!closeError && had_error) {
                closeError = new Error("TCP socket closed with error");
            }
            modbus._handleCallback(closeError);

            if (wasOpen || modbus._hadConnected) {
                modbus._safeEmit("close", had_error, modbus._lastError);
            }

            if (modbus._shouldReconnect()) {
                modbus._scheduleReconnect();
                return;
            }

            if (wasOpen) {
                modbus.removeAllListeners();
            }
        };

        this._handleSocketError = function(error) {
            modbus.openFlag = false;
            modbus._lastError = error;
            let errorMessage = error;
            if (error && error.message) {
                errorMessage = error.message;
            }
            if (modbus._connectInFlight) {
                modbus._connectionStats.failures += 1;
                modbus._connectInFlight = false;
            }
            modbus._activityLog("error", "tcp error", {
                ...modbus._getEndpointDetails(),
                ...modbus._getConnectionRatioDetails(),
                error: errorMessage
            });
            modbus._safeEmit("error", error);
            modbus._handleCallback(error);
        };

        this._handleSocketTimeout = function() {
            // Treat socket inactivity timeout as a broken connection.
            // Without this, TCP half-open situations (e.g. link loss) can leave `isOpen` true forever.
            modbusSerialDebug("TcpRTUBufferedPort port: TimedOut");
            if (modbus._connectInFlight) {
                modbus._connectionStats.failures += 1;
                modbus._connectInFlight = false;
            }
            modbus._activityLog("warn", "tcp inactivity timeout", {
                ...modbus._getEndpointDetails(),
                ...modbus._getConnectionRatioDetails()
            });
            const err = new Error("TcpRTUBufferedPort Connection Timed Out");
            modbus._lastError = err;
            modbus.openFlag = false;
            try {
                // Trigger normal error/close flow (and autoReconnect if enabled).
                if (!modbus._client.destroyed) modbus._client.destroy(err);
            } catch (e) { }
        };

        this._attachSocketHandlers(modbus._client);
    }

    _safeEmit(eventName, ...args) {
        if (eventName === "error" && this.listenerCount("error") === 0) {
            return;
        }
        this.emit(eventName, ...args);
    }

    _handleCallback(error) {
        if (this.callback) {
            this.callback(error);
            this.callback = null;
        }
    }

    _getEndpointDetails() {
        const details = {
            host: this.connectOptions.host,
            port: this.connectOptions.port
        };

        if (this._client) {
            if (typeof this._client.localAddress !== "undefined") {
                details.localAddress = this._client.localAddress;
            }
            if (typeof this._client.localPort !== "undefined") {
                details.localPort = this._client.localPort;
            }
            if (typeof this._client.remoteAddress !== "undefined") {
                details.remoteAddress = this._client.remoteAddress;
            }
            if (typeof this._client.remotePort !== "undefined") {
                details.remotePort = this._client.remotePort;
            }
        }

        return details;
    }

    _getConnectionRatioDetails() {
        const attempts = this._connectionStats.attempts;
        const successes = this._connectionStats.successes;
        const failures = this._connectionStats.failures;
        let successRatio = "0.00%";
        let failureRatio = "0.00%";

        if (attempts > 0) {
            successRatio = ((successes / attempts) * 100).toFixed(2) + "%";
            failureRatio = ((failures / attempts) * 100).toFixed(2) + "%";
        }

        return {
            connectionAttempts: attempts,
            connectionSuccesses: successes,
            connectionFailures: failures,
            successRatio: successRatio,
            failureRatio: failureRatio
        };
    }

    _attachSocketHandlers(client) {
        client.on("data", this._handleSocketData);
        client.on("connect", this._handleSocketConnect);
        client.on("close", this._handleSocketClose);
        client.on("error", this._handleSocketError);
        client.on("timeout", this._handleSocketTimeout);
    }

    _detachSocketHandlers(client) {
        client.removeListener("data", this._handleSocketData);
        client.removeListener("connect", this._handleSocketConnect);
        client.removeListener("close", this._handleSocketClose);
        client.removeListener("error", this._handleSocketError);
        client.removeListener("timeout", this._handleSocketTimeout);
    }

    _shouldReconnect() {
        return Boolean(
            this._autoReconnect &&
            !this._closing &&
            this._externalSocket === null
        );
    }

    _getReconnectDelay(attempt) {
        const { minDelay, maxDelay, backoffFactor } = this._autoReconnect;
        const delay = Math.round(minDelay * Math.pow(backoffFactor, Math.max(0, attempt - 1)));
        return Math.max(0, Math.min(maxDelay, delay));
    }

    _scheduleReconnect() {
        if (!this._autoReconnect) return;
        if (this._reconnectTimer) return;

        if (this._reconnectAttempt >= this._autoReconnect.maxRetries) {
            this._reconnecting = false;
            let errorMessage;
            if (this._lastError) {
                errorMessage = this._lastError.message;
            }
            this._activityLog("error", "tcp reconnect failed", {
                ...this._getEndpointDetails(),
                ...this._getConnectionRatioDetails(),
                attempt: this._reconnectAttempt,
                error: errorMessage
            });
            this._safeEmit("reconnect_failed", this._reconnectAttempt, this._lastError);
            return;
        }

        this._reconnecting = true;
        this._reconnectAttempt += 1;
        const delay = this._getReconnectDelay(this._reconnectAttempt);
        this._activityLog("warn", "tcp reconnect scheduled", {
            ...this._getEndpointDetails(),
            ...this._getConnectionRatioDetails(),
            attempt: this._reconnectAttempt,
            delayMs: delay
        });
        this._safeEmit("reconnecting", this._reconnectAttempt, delay, this._lastError);

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._attemptReconnect();
        }, delay);
    }

    _attemptReconnect() {
        if (!this._shouldReconnect()) return;
        this._connectionStats.attempts += 1;
        this._connectInFlight = true;
        this._activityLog("warn", "tcp reconnect attempt", {
            ...this._getEndpointDetails(),
            ...this._getConnectionRatioDetails(),
            attempt: this._reconnectAttempt
        });

        const previousClient = this._client;
        try {
            this._detachSocketHandlers(previousClient);
            if (!previousClient.destroyed) previousClient.destroy();
        } catch (e) { }

        this._buffer = Buffer.alloc(0);
        this._client = new net.Socket();
        if (this._socketTimeout) this._client.setTimeout(this._socketTimeout);
        this._attachSocketHandlers(this._client);

        try {
            this._client.connect(this.connectOptions);
        } catch (error) {
            this._lastError = error;
            let errorMessage = error;
            if (error && error.message) {
                errorMessage = error.message;
            }
            if (this._connectInFlight) {
                this._connectionStats.failures += 1;
                this._connectInFlight = false;
            }
            this._activityLog("error", "tcp reconnect attempt failed", {
                ...this._getEndpointDetails(),
                ...this._getConnectionRatioDetails(),
                attempt: this._reconnectAttempt,
                error: errorMessage
            });
            this._safeEmit("reconnect_error", this._reconnectAttempt, error);
            this._scheduleReconnect();
        }
    }

    /**
     * Check if port is open.
     *
     * @returns {boolean}
     */
    get isOpen() {
        return this.openFlag;
    }

    get isReconnecting() {
        return this._reconnecting || Boolean(this._reconnectTimer);
    }

    /**
     * Emit the received response, cut the buffer and reset the internal vars.
     *
     * @param {number} start the start index of the response within the buffer
     * @param {number} length the length of the response
     * @private
     */
    _emitData(start, length) {
        const modbus = this;
        const data = modbus._buffer.slice(start, start + length);

        // cut the buffer
        modbus._buffer = modbus._buffer.slice(start + length);

        if (data.length > 0) {
            const buffer = Buffer.alloc(data.length + CRC_LENGTH);
            data.copy(buffer, 0);

            // add crc
            const crc = crc16(buffer.slice(0, -CRC_LENGTH));
            buffer.writeUInt16LE(crc, buffer.length - CRC_LENGTH);

            modbus.emit("data", buffer);

            // debug
            modbusSerialDebug({
                action: "parsed tcp buffered port",
                buffer: buffer,
                transactionId: modbus._transactionIdRead
            });
        } else {
            modbusSerialDebug({ action: "emit data to short", data: data });
        }
    }

    /**
     * Simulate successful port open.
     *
     * @param callback
     */
    open(callback) {
        this._closing = false;
        this._lastError = null;
        this._reconnectAttempt = 0;
        this._reconnecting = false;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if(this._externalSocket === null) {
            this.callback = callback;
            this._connectionStats.attempts += 1;
            this._connectInFlight = true;
            this._activityLog("info", "tcp connect requested", {
                ...this._getEndpointDetails(),
                ...this._getConnectionRatioDetails()
            });
            this._client.connect(this.connectOptions);
        } else if(this.openFlag) {
            modbusSerialDebug("TcpRTUBuffered port: external socket is opened");
            callback(); // go ahead to setup existing socket
        } else {
            callback(new Error("TcpRTUBuffered port: external socket is not opened"));
        }
    }

    /**
     * Simulate successful close port.
     *
     * @param callback
     */
    close(callback) {
        this._closing = true;
        this._activityLog("info", "tcp close requested", {
            ...this._getEndpointDetails()
        });
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this.callback = callback;
        // DON'T pass callback to `end()` here, it will be handled by client.on('close') handler
        this._client.end();
    }

    /**
     * Simulate successful destroy port.
     *
     * @param callback
     */
    destroy(callback) {
        this._closing = true;
        this._activityLog("warn", "tcp destroy requested", {
            ...this._getEndpointDetails()
        });
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this.callback = callback;
        if (!this._client.destroyed) {
            this._client.destroy();
        }
    }

    /**
     * Send data to a modbus slave via telnet server.
     *
     * @param {Buffer} data
     */
    write(data) {
        if (data.length < MIN_DATA_LENGTH) {
            modbusSerialDebug(
                "expected length of data is to small - minimum is " +
                    MIN_DATA_LENGTH
            );
            return;
        }

        // remove crc and add mbap
        const buffer = Buffer.alloc(data.length + MIN_MBAP_LENGTH - CRC_LENGTH);
        buffer.writeUInt16BE(this._transactionIdWrite, 0);
        buffer.writeUInt16BE(0, 2);
        buffer.writeUInt16BE(data.length - CRC_LENGTH, 4);
        data.copy(buffer, MIN_MBAP_LENGTH);

        modbusSerialDebug({
            action: "send tcp rtu buffered port",
            data: data,
            buffer: buffer,
            transactionsId: this._transactionIdWrite
        });

        // get next transaction id
        this._transactionIdWrite =
            (this._transactionIdWrite + 1) % MAX_TRANSACTIONS;

        // send buffer to slave
        this._client.write(buffer);
    }
}

/**
 * TCP RTU buffered port for Modbus.
 *
 * @type {TcpRTUBufferedPort}
 */
module.exports = TcpRTUBufferedPort;

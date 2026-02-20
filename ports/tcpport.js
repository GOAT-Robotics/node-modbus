"use strict";
const events = require("events");
const EventEmitter = events.EventEmitter || events;
const net = require("net");
const modbusSerialDebug = require("debug")("modbus-serial");

const crc16 = require("../utils/crc16");
const createActivityLogger = require("../utils/activity_logger");

/* TODO: const should be set once, maybe */
const MODBUS_PORT = 502; // modbus port
const MAX_TRANSACTIONS = 256; // maximum transaction to wait for
const MIN_DATA_LENGTH = 4; // custom function can have length 4
const MIN_MBAP_LENGTH = 6;
const CRC_LENGTH = 2;

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

class TcpPort extends EventEmitter {
    /**
     * Simulate a modbus-RTU port using modbus-TCP connection.
     *
     * @param {string} ip - IP address of Modbus slave.
     * @param {{
     *  port?: number,
     *  localAddress?: string,
     *  family?: 0|4|6,
     *  timeout?: number,
     *  socket?: net.Socket
     *  socketOpts?: {
     *      fd: number,
     *      allowHalfOpen?: boolean,
     *      readable?: boolean,
     *      writable?: boolean,
     *      signal?: AbortSignal
     *  },
     * } & net.TcpSocketConnectOpts} options - Options object.
     *   options.port: Nonstandard Modbus port (default is 502).
     *   options.localAddress: Local IP address to bind to, default is any.
     *   options.family: 4 = IPv4-only, 6 = IPv6-only, 0 = either (default).
     * @constructor
     */
    constructor(ip, options) {
        super();
        const self = this;
        /** @type {boolean} Flag to indicate if port is open */
        this.openFlag = false;
        /** @type {(err?: Error) => void} */
        this.callback = null;
        this._transactionIdWrite = 1;
        /** @type {net.Socket?} - Optional custom socket */
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
        this._destroying = false;

        if (typeof ip === "object") {
            options = ip;
            ip = undefined;
        }

        if (typeof options === "undefined") options = {};
        const modbusLogEnabled = Boolean(options.modbusLogEnabled);
        delete options.modbusLogEnabled;
        this._activityLog = createActivityLogger("tcp-port", null, { enabled: modbusLogEnabled });

        // normalize reconnect options and strip them from net.connect() options
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

        this.socketOpts = undefined;
        if (options.socketOpts) {
            this.socketOpts = options.socketOpts;
            delete options.socketOpts;
        }

        if (typeof options.timeout === "number") {
            this._socketTimeout = options.timeout;
        }

        /** @type {net.TcpSocketConnectOpts} - Options for net.connect(). */
        this.connectOptions = {
            // Default options
            ...{
                host: ip || options.ip,
                port: MODBUS_PORT
            },
            // User options
            ...options
        };

        this._autoReconnect = normalizeAutoReconnect(reconnectOptions);
        if (this._keepAlive === null) {
            if (this._autoReconnect) {
                this._keepAlive = true;
            } else {
                this._keepAlive = false;
            }
        }

        if (options.socket) {
            if (options.socket instanceof net.Socket) {
                this._externalSocket = options.socket;
                this.openFlag = this._externalSocket.readyState === "opening" || this._externalSocket.readyState === "open";
            } else {
                throw new Error("invalid socket provided");
            }
        }

        // init a socket
        this._client = this._externalSocket || new net.Socket(this.socketOpts);
        this._writeCompleted = Promise.resolve();
        if (this._socketTimeout) this._client.setTimeout(this._socketTimeout);

        // bind handlers once so we can re-attach them on reconnect
        this._handleSocketData = function(data) {
            let buffer;
            let crc;
            let length;

            // data received
            modbusSerialDebug({ action: "receive tcp port strings", data: data });

            // check data length
            while (data.length > MIN_MBAP_LENGTH) {
                // parse tcp header length
                length = data.readUInt16BE(4);

                // cut 6 bytes of mbap and copy pdu
                buffer = Buffer.alloc(length + CRC_LENGTH);
                data.copy(buffer, 0, MIN_MBAP_LENGTH);

                // add crc to message
                crc = crc16(buffer.slice(0, -CRC_LENGTH));
                buffer.writeUInt16LE(crc, buffer.length - CRC_LENGTH);

                // update transaction id and emit data
                self._transactionIdRead = data.readUInt16BE(0);
                self.emit("data", buffer);

                // debug
                modbusSerialDebug({ action: "parsed tcp port", buffer: buffer, transactionId: self._transactionIdRead });

                // reset data
                data = data.slice(length + MIN_MBAP_LENGTH);
            }
        };

        this._handleSocketConnect = function() {
            const wasReconnecting = self._reconnecting;
            const reconnectAttempt = self._reconnectAttempt;

            self.openFlag = true;
            self._hadConnected = true;
            self._writeCompleted = Promise.resolve();
            self._reconnecting = false;
            self._lastError = null;
            self._connectInFlight = false;
            self._connectionStats.successes += 1;
            if (self._reconnectTimer) {
                clearTimeout(self._reconnectTimer);
                self._reconnectTimer = null;
            }
            modbusSerialDebug("TCP port: signal connect");
            self._activityLog("info", "tcp connected", {
                ...self._getEndpointDetails(),
                ...self._getConnectionRatioDetails()
            });
            self._client.setNoDelay();
            if (self._keepAlive && typeof self._client.setKeepAlive === "function") {
                self._client.setKeepAlive(true, self._keepAliveInitialDelay);
            }
            self._safeEmit("connect");
            if (wasReconnecting) {
                self._safeEmit("reconnect", reconnectAttempt);
            }
            self._handleCallback();
        };

        this._handleSocketClose = function(had_error) {
            const wasOpen = self.openFlag;
            self.openFlag = false;

            modbusSerialDebug("TCP port: signal close: " + had_error);
            let lastErrorMessage;
            if (self._lastError && self._lastError.message) {
                lastErrorMessage = self._lastError.message;
            }
            if (had_error) {
                if (self._connectInFlight) {
                    self._connectionStats.failures += 1;
                    self._connectInFlight = false;
                }
                self._activityLog("warn", "tcp disconnected", {
                    ...self._getEndpointDetails(),
                    ...self._getConnectionRatioDetails(),
                    hadError: Boolean(had_error),
                    error: lastErrorMessage
                });
            } else {
                self._activityLog("info", "tcp disconnected", {
                    ...self._getEndpointDetails(),
                    ...self._getConnectionRatioDetails(),
                    hadError: Boolean(had_error),
                    error: lastErrorMessage
                });
            }
            let closeError = self._lastError;
            if (!closeError && had_error) {
                closeError = new Error("TCP socket closed with error");
            }
            self._handleCallback(closeError);

            if (wasOpen || self._hadConnected) {
                self._safeEmit("close", had_error, self._lastError);
            }

            if (self._shouldReconnect()) {
                self._scheduleReconnect();
                return;
            }

            // preserve historic behavior: once closed, remove all listeners
            // (unless reconnect is enabled).
            if (wasOpen) {
                self.removeAllListeners();
            }
        };

        this._handleSocketError = function(error) {
            self.openFlag = false;
            self._lastError = error;
            modbusSerialDebug("TCP port: signal error: " + error);
            let errorMessage = error;
            if (error && error.message) {
                errorMessage = error.message;
            }
            if (self._connectInFlight) {
                self._connectionStats.failures += 1;
                self._connectInFlight = false;
            }
            self._activityLog("error", "tcp error", {
                ...self._getEndpointDetails(),
                ...self._getConnectionRatioDetails(),
                error: errorMessage
            });
            self._safeEmit("error", error);
            self._handleCallback(error);
        };

        this._handleSocketTimeout = function(error) {
            // Treat socket inactivity timeout as a broken connection.
            // Without this, TCP half-open situations (e.g. link loss) can leave `isOpen` true forever.
            modbusSerialDebug("TCP port: TimedOut");
            if (self._connectInFlight) {
                self._connectionStats.failures += 1;
                self._connectInFlight = false;
            }
            self._activityLog("warn", `tcp socket timeout ${error}`, {
                ...self._getEndpointDetails(),
                ...self._getConnectionRatioDetails()
            });
            const err = new Error("TCP Connection Timed Out");
            self._lastError = err;
            self.openFlag = false;
            try {
                // Trigger normal error/close flow (and autoReconnect if enabled).
                if (!self._client.destroyed) self._client.destroy(err);
            } catch (e) { }
        };

        this._attachSocketHandlers(this._client);
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
        client.on("close", this._handleSocketClose);
        client.on("connect", this._handleSocketConnect);
        client.on("connectionAttempt", (socket) => {
            this._activityLog("warn", "TCP port: connection event", socket);
        });
        client.on("connectionAttemptFailed", (error) => {
            this._activityLog("warn", "TCP port: connection attempt failed", error);
        });
        client.on("connectionAttemptTimeout",  (error) => {
            this._activityLog("warn", "TCP port: connection attempt timed out", error);
        });
        client.on("data", this._handleSocketData);
        client.on("drain", () => {
            this._activityLog("warn", "TCP port: drain event emitted");
        });
        client.on("end", () => {
            this._activityLog("warn", "TCP port: end event emitted");
        });
        client.on("error", this._handleSocketError);
        client.on("lookup", (err, address, family, host) => {
            if (err) {
                this._activityLog("error", "TCP port: lookup error", err);
            } else {
                this._activityLog("info", `TCP port: lookup result - address: ${address}, family: ${family}, host: ${host}`);
            }
        });
        client.on("ready", () => {
            this._activityLog("info", "TCP port: ready event emitted");
        });
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
            !(this._closing && !this._destroying) &&
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
            delayMs: delay,
            scheduledAt: new Date(Date.now() + delay).toISOString()
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

        // replace the socket instance (a closed socket can't reliably reconnect)
        const previousClient = this._client;
        try {
            this._detachSocketHandlers(previousClient);
            if (!previousClient.destroyed) previousClient.destroy();
        } catch (e) { }

        this._client = new net.Socket(this.socketOpts);
        this._writeCompleted = Promise.resolve();
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
     * Simulate successful port open.
     *
     * @param {(err?: Error) => void} callback
     */
    open(callback) {
        this._closing = false;
        this._destroying = false;
        this._lastError = null;
        this._reconnectAttempt = 0;
        this._reconnecting = false;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._externalSocket === null) {
            this.callback = callback;
            this._connectionStats.attempts += 1;
            this._connectInFlight = true;
            this._activityLog("info", "tcp connect requested", {
                ...this._getEndpointDetails(),
                ...this._getConnectionRatioDetails()
            });
            this._client.connect(this.connectOptions);
        } else if (this.openFlag) {
            modbusSerialDebug("TCP port: external socket is opened");
            callback(); // go ahead to setup existing socket
        } else {
            callback(new Error("TCP port: external socket is not opened"));
        }
    }

    /**
     * Simulate successful close port.
     *
     * @param {(err?: Error) => void} callback
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
     * @param {(err?: Error) => void} callback
     */
    destroy(callback) {
        this._destroying = true;
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
     * Send data to a modbus-tcp slave.
     *
     * @param {Buffer} data
     */
    write(data) {
        if (data.length < MIN_DATA_LENGTH) {
            modbusSerialDebug("expected length of data is to small - minimum is " + MIN_DATA_LENGTH);
            return;
        }

        // remember current unit and command
        this._id = data[0];
        this._cmd = data[1];

        // remove crc and add mbap
        const buffer = Buffer.alloc(data.length + MIN_MBAP_LENGTH - CRC_LENGTH);
        buffer.writeUInt16BE(this._transactionIdWrite, 0);
        buffer.writeUInt16BE(0, 2);
        buffer.writeUInt16BE(data.length - CRC_LENGTH, 4);
        data.copy(buffer, MIN_MBAP_LENGTH);

        modbusSerialDebug({
            action: "send tcp port",
            data: data,
            buffer: buffer,
            unitid: this._id,
            functionCode: this._cmd,
            transactionsId: this._transactionIdWrite
        });

        // send buffer to slave
        const previousWritePromise = this._writeCompleted;
        const newWritePromise = new Promise((resolveNewWrite, rejectNewWrite) => {
            // Wait for the completion of any write that happened before.
            previousWritePromise.finally(() => {
                try {
                    // The previous write succeeded, write the new buffer.
                    if (this._client.write(buffer)) {
                        // Mark this write as complete.
                        resolveNewWrite();
                    } else {
                        // Wait for one `drain` event to mark this write as complete.
                        this._client.once("drain", resolveNewWrite);
                    }
                } catch (error) {
                    rejectNewWrite(error);
                }
            });
        });
        // Overwrite `_writeCompleted` so that the next call to `TcpPort.write` will have to wait on our write to complete.
        this._writeCompleted = newWritePromise;

        // set next transaction id
        this._transactionIdWrite = (this._transactionIdWrite + 1) % MAX_TRANSACTIONS;
    }
}

/**
 * TCP port for Modbus.
 *
 * @type {TcpPort}
 */
module.exports = TcpPort;

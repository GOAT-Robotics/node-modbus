"use strict";
/* eslint-disable no-undef */

const expect = require("chai").expect;
const mockery = require("mockery");
const sinon = require("sinon");
const events = require("events");
const EventEmitter = events.EventEmitter || events;

describe("Modbus TCP port reconnection", function() {
    let TcpPort;
    let clock;
    let sockets;

    beforeEach(function() {
        sockets = [];
        clock = sinon.useFakeTimers();

        const netMock = {};
        netMock.Socket = class Socket extends EventEmitter {
            constructor() {
                super();
                this.destroyed = false;
                sockets.push(this);
            }

            connect(options) {
                this._connectOptions = options;
                setTimeout(() => this.emit("connect"), 0);
            }

            setNoDelay() {
                return this;
            }

            setTimeout() {
                return this;
            }

            end() {
                this.emit("close", false);
            }

            write() {
                this._didWrite = true;
                return true;
            }

            destroy() {
                this.destroyed = true;
            }
        };

        mockery.resetCache();
        mockery.enable({ warnOnReplace: false, useCleanCache: true, warnOnUnregistered: false });
        mockery.registerMock("net", netMock);
        TcpPort = require("./../../ports/tcpport");
    });

    afterEach(function() {
        mockery.disable();
        clock.restore();
    });

    it("should reconnect after an unexpected close", function() {
        const port = new TcpPort("127.0.0.1", {
            port: 9999,
            autoReconnect: { maxRetries: 3, minDelay: 10, maxDelay: 10, backoffFactor: 1 }
        });

        let opened = false;
        port.open(function(err) {
            expect(err).to.equal(undefined);
            opened = true;
        });
        clock.tick(0);
        expect(opened).to.equal(true);
        expect(port.isOpen).to.equal(true);

        const firstClient = port._client;
        let reconnectingAttempt;
        port.once("reconnecting", function(attempt) {
            reconnectingAttempt = attempt;
        });

        // simulate an unexpected remote close
        port._client.emit("close", false);
        expect(port.isOpen).to.equal(false);
        expect(port.isReconnecting).to.equal(true);

        // fire reconnect timer and connect callback
        clock.runAll();

        expect(reconnectingAttempt).to.equal(1);
        expect(port.isOpen).to.equal(true);
        expect(port._client).to.not.equal(firstClient);
        expect(sockets.length).to.equal(2);
    });
});

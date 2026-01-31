"use strict";
/* eslint-disable no-undef */

const expect = require("chai").expect;
const sinon = require("sinon");
const events = require("events");
const EventEmitter = events.EventEmitter || events;

const ModbusRTU = require("./../index");

class SilentPort extends EventEmitter {
    constructor() {
        super();
        this.openFlag = false;
        this._transactionIdWrite = 1;
        this._transactionIdRead = 1;
        this.isReconnecting = false;
        this.destroyCount = 0;
    }

    get isOpen() {
        return this.openFlag;
    }

    open(callback) {
        this.openFlag = true;
        callback();
    }

    write() {
        // never responds
        this._didWrite = true;
    }

    destroy(callback) {
        this.destroyCount += 1;
        this.openFlag = false;
        this.emit("close", true, new Error("forced"));
        if (callback) callback();
    }
}

describe("ModbusRTU reconnect on transaction timeout", function() {
    it("should force a reconnect after N consecutive timeouts", async function() {
        const clock = sinon.useFakeTimers();
        try {
            const port = new SilentPort();
            const client = new ModbusRTU(port);
            client.setTimeout(10);
            client._setReconnectOnTimeout(1);

            await new Promise((resolve, reject) => {
                client.open((err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });

            const promise = client.readHoldingRegisters(0, 1);
            clock.tick(11);

            try {
                await promise;
                throw new Error("expected readHoldingRegisters to fail");
            } catch (err) {
                expect(err).to.be.an("object");
                expect(err.message).to.equal("Timed out");
                expect(err.errno).to.equal("ETIMEDOUT");
            }

            expect(port.destroyCount).to.equal(1);
        } finally {
            clock.restore();
        }
    });
});

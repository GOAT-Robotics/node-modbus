"use strict";
/* eslint-disable no-undef */

const expect = require("chai").expect;
const events = require("events");
const EventEmitter = events.EventEmitter || events;

const ModbusRTU = require("./../index");

class FakePort extends EventEmitter {
    constructor() {
        super();
        this.openFlag = false;
        this._transactionIdWrite = 1;
        this._transactionIdRead = 1;
        this.isReconnecting = false;
    }

    get isOpen() {
        return this.openFlag;
    }

    open(callback) {
        this.openFlag = true;
        callback();
    }

    close(callback) {
        this.openFlag = false;
        this.emit("close", false, new Error("closed"));
        if (callback) callback();
    }

    write() {
        // simulate an abrupt disconnect during an in-flight request
        setTimeout(() => {
            this.openFlag = false;
            this.emit("close", false, new Error("disconnect"));
        }, 0);
    }
}

describe("ModbusRTU disconnection errors", function() {
    it("should fail pending requests when the port disconnects", async function() {
        const client = new ModbusRTU(new FakePort());

        await new Promise((resolve, reject) => {
            client.open((err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });

        try {
            await client.readHoldingRegisters(0, 1);
            throw new Error("expected readHoldingRegisters to fail");
        } catch (err) {
            expect(err).to.be.an("object");
            expect(err.message).to.equal("Port Closed");
            expect(err.errno).to.equal("ECONNRESET");
            expect(err.cause).to.be.an("error");
            expect(err.cause.message).to.equal("disconnect");
        }
    });

    it("should return a distinct error while reconnecting", async function() {
        const port = new FakePort();
        port.isReconnecting = true;
        const client = new ModbusRTU(port);

        try {
            await client.readHoldingRegisters(0, 1);
            throw new Error("expected readHoldingRegisters to fail");
        } catch (err) {
            expect(err).to.be.an("object");
            expect(err.message).to.equal("Port Reconnecting");
            expect(err.errno).to.equal("EAGAIN");
        }
    });
});

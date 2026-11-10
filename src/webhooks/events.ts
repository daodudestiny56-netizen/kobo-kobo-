import { EventEmitter } from "node:events";

// Caleb's sweep engine subscribes: bankEvents.on("transfer.reversed", (data) => ...)
// "data" is the raw bank transfer object (snake_case), not the mapped Transfer type.
export const bankEvents = new EventEmitter();

/**
 * @module lib/color-worker
 * A worker to color resources
 */
import {ImageResourceManager} from "./color-worker-manager";
import {BrushFactory} from "./brush-factory";
import {TransferDirection} from "./brush";
import {compressColor} from "./util";

class ColorWorkerQueue {
    constructor() {
        this.queue = [];
        this.running = false;
    }

    process(task) {
        this.queue.push(task);
        if (!this.running)
            this._doNext();
    }

    _doNext() {
        // if we are still running and have exhausted queue, then just stop
        if (this.queue.length === 0) {
            this.running = false;
            return;
        }

        this.running = true;

        // process current task
        const {
            id,
            inputBuffer, outputBuffer, outputPointSize,
            schema, totalPoints, brushes} = this.queue.shift();

        var point = {};
        const numItems = schema.length;

        const preppedBrushes = BrushFactory.endTransferForBrushes(TransferDirection.MAIN_TO_WORKER, brushes);

        const schemaRenamed = schema.slice(0).map(s => {
            s.name = s.name.toLowerCase();
            return s;
        });

        const decomposePoint = (index) => {
            const offset = index * numItems;
            for (let i = 0 ; i < numItems ; i ++) {
                point[schemaRenamed[i].name] = inputBuffer[offset + i];
            }
            return point;
        };

        let writeOffset = 0;
        let color = [0, 0, 0];
        for (let i = 0 ; i < totalPoints ; i ++) {
            const p = decomposePoint(i);
            outputBuffer[writeOffset] = p.x;
            outputBuffer[writeOffset + 1] = p.y;
            outputBuffer[writeOffset + 2] = p.z;

            for (let bi = 0, bl = preppedBrushes.length; bi < bl; bi++) {
                const brush = preppedBrushes[bi];
                if (brush) {
                    brush.colorPoint(color, p);
                    outputBuffer[writeOffset + 3 + bi] = compressColor(color);
                }
            }

            writeOffset += outputPointSize;
        }

        // collect back the params
        const returnTransfer = BrushFactory.beginTransferForBrushes(TransferDirection.WORKER_TO_MAIN, preppedBrushes);

        // post back completion
        postMessage({
            id, inputBuffer, outputBuffer,
            brushes: returnTransfer.params
        }, [inputBuffer.buffer, outputBuffer.buffer].concat(returnTransfer.transferList));

        setTimeout(() => { this._doNext(); });
    }
}

let queue = new ColorWorkerQueue();

onmessage = (e) => {
    const { data } = e;
    data.task.id = data.id;
    queue.process(data.task);
};


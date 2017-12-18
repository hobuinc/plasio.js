/**
 * @module image-resource
 * Manages cross thread large buffer resources (mostly images) such that the main thread mananages the resources
 * and selectively returns them to workers which request access to it (using transfer buffers)
 */

import { GenericWorkerQueue} from "./generic-worker-queue";

export class ColorWorkerManager extends GenericWorkerQueue {
    constructor(loaderCount) {
        super("color-worker", loaderCount, window.PLASIO_COLOR_WORKER_PATH || "lib/dist/plasio.color.webworker.js");
    }

    handleNewRequest(inputParams) {
        return inputParams
    }

    handleResponse(data, resolve, reject) {
        resolve(data);
    }
}
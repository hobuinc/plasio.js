/**
 * @module generic-worker-queue
 * Base class abstraction for managing workers
 */

const util = require('./util');

/**
 * A base class for all web-worker queued operations, hide details dealing with worker management
 */
export class GenericWorkerQueue {
    /**
     * Create a new instance of the worker queue
     * @param {String} queueName The name of the queue
     * @param {Number} loaderCount The number of loaders needed
     * @param {String} webWorkerPath The path to the script
     */
    constructor(queueName, loaderCount, webWorkerPath) {
        this.queueName = queueName;
        this.loaderCount = loaderCount;
        this.webWorkerPath = webWorkerPath;

        this.loaders = [];
        for (let i = 0; i < this.loaderCount; i++) {
            this.loaders.push(this._newWorker(i));
        }
    }

    /**
     * Push a new task to the web worker
     * @param {Object} inputParams The input parameters for the task
     * @returns {Promise<any>} A promise which is resolved when the task completes
     */
    push(inputParams) {
        // find a loader with the minimum amount of load
        const candidate = this.loaders.sort((a, b) =>
            Object.keys(a.processQueue).length - Object.keys(b.processQueue).length)[0];
        const requestId = util.randomId();

        const { params, transferList } = this.handleNewRequest(inputParams);

        return new Promise((resolve, reject) => {
            candidate.processQueue[requestId] = {
                resolve: resolve,
                reject: reject,
                worker: candidate
            };

            candidate.postMessage({
                id: requestId,
                task: params
            }, transferList);
        });
    }

    /**
     * The function to override to handle responses
     * @param {Object} data The object as received from the worker
     * @param {Function} resolve The method to resolve to success
     * @param {Function} reject The method to resolve with error
     */
    handleResponse(data, resolve, reject) {
        throw new Error('Not Implemented');
    }

    /**
     * The function to process new tasks requests, the input parameters may be transformed by this function
     * which will then be sent to the web worker as is (with on additional id field)
     * @param {Object} inputParams The input parameters as pushed by the caller
     * @return {Object} An object which will be sent to the web worker, as params and a transferList
     */
    handleNewRequest(inputParams) {
        throw new Error('Not Implemented');
    }

    _newWorker(index) {
        const w = new Worker(this.webWorkerPath);

        w.id = index;
        w.processQueue = {};

        w.onmessage = (e) => {
            this._processResponse(w, e.data);
        };

        w.onerror = (e) => {
            console.log(this.queueName + ": Worker crashed!", w);
            console.error(e);
            this._handleError(w);
        };

        console.log(this.queueName + ": worker instantiated.");
        return w;
    }

    _processResponse(worker, data) {
        const requestId = data.id;

        const {resolve, reject} = worker.processQueue[requestId];
        if (!resolve || !reject)
            return console.log(this.queueName + ': WARNING: Got a response from a webworker for request which has no associated completion promise');

        // Clear out this item from waiting requests and
        delete worker.processQueue[requestId];
        console.log(this.queueName + ': worker ' +  worker.id + ' queue now has: ' + Object.keys(worker.processQueue).length + ' items.');

        this.handleResponse(data, resolve, reject);
    }

    _handleError(worker) {
        const id = worker.id;
        this.loaders = this.loaders.filter(w => w.id !== id);

        console.log(this.queueName + ': WARNING: Worker with id', id, 'was decomissioned');
    }

}

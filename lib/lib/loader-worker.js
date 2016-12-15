// Loader worker
// Loads and processes data buffers from greyhound


const processQueue = [];

onmessage = (event) => {
    const data = event.data;

    const requestId = data.id;
    const task = data.task;

    setTimeout(() => {
        postMessage({
            id: requestId,
            success: true,
            buffer: new Float32Array(12 * 20),
            numPoints: 20
        });
    })
};
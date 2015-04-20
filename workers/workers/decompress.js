// decompress.js
// webworker for decompressing stuff
//

importScripts("../lib/dist/laz-perf.js");

var totalSaved = 0;
var decompressBuffer = function(schema, ab, numPoints) {
	var x = new Module.DynamicLASZip();

	var abInt = new Uint8Array(ab);
	var buf = Module._malloc(ab.byteLength);

	Module.HEAPU8.set(abInt, buf);
	x.open(buf, ab.byteLength);

	var pointSize = 0;

	schema.forEach(function(f) {
		pointSize += f.size;
		if (f.type === "floating")
			x.addFieldFloating(f.size);
		else if (f.type === "unsigned")
			x.addFieldUnsigned(f.size);
		else
			throw new Error("Unrecognized field desc:", f);
	});

	totalSaved += (numPoints * pointSize) - ab.byteLength;
	/*
	console.log("Decompress points:", numPoints,
	            "bytes: ", ab.byteLength, "->", numPoints * pointSize, "saved:", totalSaved);
	 */

	var out = Module._malloc(numPoints * pointSize);

	for (var i = 0 ; i < numPoints ; i ++) {
		x.getPoint(out + i * pointSize);
	}

	var ret = new Uint8Array(numPoints * pointSize);
	ret.set(Module.HEAPU8.subarray(out, out + numPoints * pointSize));

	Module._free(out);
	Module._free(buf);

	var b = new Float32Array(ret.buffer);

	return b;
};

self.onmessage = function(e) {
	var data = e.data;
	
	var schema = data.schema;
	var ab = data.buffer;
	var numPoints = data.pointsCount;

	var res = decompressBuffer(schema, ab, numPoints);
	postMessage({result: res}, [res.buffer]);
};

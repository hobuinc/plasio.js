// util.js
// much wow utility functions
//

var vec3 = require("gl-matrix").vec3;

var suc = function(s) {
    return Math.floor(s/100) == 2;
};

var getBinary = function(url, cb) {
    var r = new XMLHttpRequest();

    r.open("GET", url);
    r.responseType = "arraybuffer";

    r.onload = function(e) {
        if (this.readyState === 4) {
            // this request is done
            if (this.status === 200) {
                cb(null,
                   this.getResponseHeader('content-type'),
                   this.response,
                   parseInt(this.getResponseHeader('X-Greyhound-Num-Points')));
            }
            else
                cb(new Error("Unsuccessful error code: " + this.status));
        }
    };
    r.send();
};


var get = function(url, cb) {
    var xmlhttp;
    if (window.XMLHttpRequest) {
        xmlhttp=new XMLHttpRequest();
    }
    else {
        xmlhttp=new ActiveXObject("Microsoft.XMLHTTP");
    }

    xmlhttp.onreadystatechange=function() {
        if (xmlhttp.readyState==4) {
            if (suc(xmlhttp.status))
                cb(null, xmlhttp.responseText);
            else
                cb(new Error("unsuccessful code: " + xmlhttp.status));
        }
    };

    xmlhttp.open("GET",url,true);
    xmlhttp.send();
};

var getJson = function(url, cb) {
    get(url, function(err, contentType, data) {
        if (err) return cb(err);

        if (!contentType.match(/^application\/json/))
            return cb(new Error("The recieved data type was not JSON, it was: " + contentType));

        return cb(null, JSON.parse(data.toString('utf-8')));
    });
};

var getWithTimeout = function(url, to, cb) {
    var xmlhttp;
    if (window.XMLHttpRequest) {
        xmlhttp=new XMLHttpRequest();
    }
    else {
        xmlhttp=new ActiveXObject("Microsoft.XMLHTTP");
    }

    xmlhttp.onreadystatechange=function() {
        if (xmlhttp.readyState==4) {
            if (suc(xmlhttp.status))
                cb(null, xmlhttp.responseText);
            else
                cb(new Error("unsuccessful code: " + xmlhttp.status));
        }
    };

    xmlhttp.ontimeout = function() {
        cb(new Error("Timeout"));
    };

    xmlhttp.open("GET",url,true);
    xmlhttp.timeout = to;
    xmlhttp.send();

};


var put = function(url, params, cb) {
    var http = new XMLHttpRequest();
    var p = [];
    for(var k in params) {
        p.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    }

    p = p.join("&");

    http.open("PUT", url, true);

    //Send the proper header information along with the request
    http.setRequestHeader("Content-type", "application/x-www-form-urlencoded");

    http.onreadystatechange = function() {//Call a function when the state changes.
        if(http.readyState == 4) {
            if(suc(http.status)) {
                cb(null, http.responseText);
            }
            else {
                cb(new Error("Unsuccessful error code:", http.status));
            }
        }
    };
    http.send(p);
};

var clamp = function(v, n, x) {
    return Math.min(x, Math.max(v, n));
};

var geocenter = function(bbox) {
    // get the center of the box and then transform it into our
    // coordinate space
    //
    var center = [bbox.mins[0] + (bbox.maxs[0] - bbox.mins[0]) / 2,
                  bbox.mins[1] + (bbox.maxs[1] - bbox.mins[1]) / 2,
                  bbox.mins[2] + (bbox.maxs[2] - bbox.mins[2]) / 2];

    // now transform it
    return [-center[0], center[2], center[1]];
};

var geodist = function(a, b) {
    return vec3.distance([a[0], 0, a[2]],
                         [b[0], 0, b[2]]);
    
};

var ginside = function(bbox, loc) {
    var x1 = bbox.mins[0];
    var x2 = bbox.maxs[0];

    var y1 = bbox.mins[1];
    var y2 = bbox.maxs[1];
    var x = -loc[0], y = loc[2];

    return (x >= x1 && x < x2 && y >= y1 && y < y2);
};

var TriggeredDispatch = function(to, cb) {
    this.to = to;
    this.cb = cb;
    this.timer = null;
    this.v = undefined;
};

TriggeredDispatch.prototype.val = function(v) {
    this.v = v;
    
    if (this.timer !== null) {
        // there is an active timer, clear it out
        clearTimeout(this.timer);
        this.timer = null;
    }

    if (this.v !== undefined) {
        var o = this;
        this.timer = setTimeout(function() {
            o.timer = null;
            process.nextTick(o.cb.bind(null, o.v));
        }, this.to);
    }
};

TriggeredDispatch.prototype.forceTrigger = function() {
	// force trigger the last recieved value
	if (this.v) {
        if (this.timer !== null) {
            // there is an active timer, clear it out
            clearTimeout(this.timer);
            this.timer = null;
        }

		process.nextTick(o.cb.bind(null, o.v));
	}
};




module.exports = {
    getBinary: getBinary,
    getJson: getJson,
    get: get,
    getWithTimeout: getWithTimeout,
    put: put,
    clamp: clamp,
    geocenter: geocenter,
    geodist: geodist,
    ginside: ginside,
    TriggeredDispatch: TriggeredDispatch
};

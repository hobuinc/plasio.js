// some js util routines
//

goog.provide('renderer.jsutil');

renderer.jsutil.fastMergeStatsNode = function (currentMap, newNode) {
    if (!currentMap)
        currentMap = new Map();

    for (var k in newNode) {
        var curr = currentMap.get(k) || 0;
        curr += newNode[k];
        currentMap.set(k, curr);
    }

    return currentMap;
};


renderer.jsutil.fastUnmergeStatsNode = function (currentMap, newNode) {
    if (!currentMap)
        return;

    for (var k in newNode) {
        var curr = currentMap.get(k) || 0;
        curr -= newNode[k];
        currentMap.set(k, curr);
    }

    return currentMap;
};


renderer.jsutil.jsMapsAreEqual = function(map1, map2) {
    var testVal;

    // if both are null
    if (!map1 && !map2)
        return true;

    // if one of them is null
    if (!map1 || !map2)
        return false;

    if (map1.size !== map2.size) {
        return false;
    }
    for (var key in map1) {
        var val = map1.get(key);
        testVal = map2.get(key);
        // in cases of an undefined value, make sure the key
        // actually exists on the object so there are no false positives
        if (testVal !== val || (testVal === undefined && !map2.has(key))) {
            return false;
        }
    }
    return true;
};


renderer.jsutil.jsMapHasNonZeroValue = function(map) {
    if (map.size === 0)
        return false;

    for (var key in map) {
        var val = map.get(key);
        if (val !== 0)
            return true;
    }

    return false;
};

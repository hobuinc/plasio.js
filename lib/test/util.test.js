var assert = require('assert');

var util = require('../lib/util');

describe('utils', function() {
    const tf = util.transformCoordinateSystem;

    describe('transformCoordinateSystem', function() {
        it('should error out if an invalid transform is specified', function() {
            assert.throws(() => tf([0,0,0], "junk", "otherjunk", {}));
            assert.throws(() => tf([0,0,0], "tree", "otherjunk", {}));
        });

        it('should error out if geoTransform is invalid', function() {
            assert.throws(() => tf([0,0,0], "tree", "geo", {}));
            assert.throws(() => tf([0,0,0], "tree", "geo", {geoBounds: [0,0,0, 1,1,1]}));
        });

        describe('with validate data', function() {
            let geoTransform = {
                fullGeoBounds: [0, 0, 0, 100, 100, 10],
                scale: [0.1, 0.1, 1],
                offset: [50, 50, 5]
            };

            it('should transform for same transform space type correctly', function() {
                assert.deepEqual(
                    tf([50, 50, 50], 'tree', 'tree', geoTransform),
                    [50, 50, 50]
                );

                assert.deepEqual(
                    tf([50, 10, 10], 'geo', 'geo', geoTransform),
                    [50, 10, 10]
                );

                assert.deepEqual(
                    tf([50, 10, 10], 'render', 'render', geoTransform),
                    [50, 10, 10]
                );
            });


            it('should transform between coordinates correctly', function() {
                assert.deepEqual(
                    tf([0, 0, 0], 'geo', 'tree', geoTransform),
                    [-500, -500, -5]
                );

                assert.deepEqual(
                    tf([100, 100, 5], 'geo', 'tree', geoTransform),
                    [500, 500, 0]
                );

                assert.deepEqual(
                    tf([0, 0, 0], 'tree', 'geo', geoTransform),
                    [50, 50, 5]
                );

                assert.deepEqual(
                    tf([100, 0, 10], 'geo', 'tree', geoTransform),
                    [500, -500, 5]
                );


                assert.deepEqual(
                    tf([0, 0, 0], 'geo', 'render', geoTransform),
                    [50, -5, -50]
                );

                let geoTransform2 = {
                    fullGeoBounds: [-1500, 800, 200, -1100, 1200, 600],
                    offset: [-1300, 1000, 400],
                    scale: [0.01, 0.01, 0.01]
                };

                assert.deepEqual(
                    tf([0,0,0], 'render', 'geo', geoTransform2),
                    [-1300, 1000, 400]
                );

                assert.deepEqual(
                    tf([0,0,0], 'render', 'tree', geoTransform2),
                    [0, 0, 0]
                );

                assert.deepEqual(
                    tf([0,0,0], 'render', 'tree', geoTransform2),
                    [0, 0, 0]
                );

                assert.deepEqual(
                    tf([0,0,0], 'render', 'tree', geoTransform2),
                    [0, 0, 0]
                );
            });
        })
    });
});
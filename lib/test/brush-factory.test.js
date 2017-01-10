// brush-factory.test.js

var expect = require('expect.js');

import { BrushFactory } from '../lib/brush-factory';
import { BaseBrush } from '../lib/brush';
import { LocalColor } from '../lib/stock-brushes/local-color';

import { FunkyColor } from './test-utils';

describe('BrushFactory', () => {
    describe('createBrush', () => {
        it('should fail for unrecognized spec', () => {
            expect(() => {
                BrushFactory.createBrush('fail://brush')
            }).to.throwError(/Unrecognized brush/);
        });

        it('should create the brush of registered kind', () => {
            const b = BrushFactory.createBrush('local://color');

            expect(b).to.be.a(BaseBrush);
            expect(b).to.be.a(LocalColor);
        });
    });

    describe('availableBrushes', () => {
        it('should report available brush specs', () => {
            const b = BrushFactory.availableBrushes();

            expect(b).to.be.an(Array);
            expect(b).to.have.length(2);
            expect(b[0]).to.eql('local://color');
            expect(b[1]).to.eql('local://ramp');
        });
    });

    describe('registerBrush/deregisterBrush', () => {
        it('should handle registration/deregistration correctly', () => {
            BrushFactory.registerBrush('local', 'manycolor', LocalColor);

            const b = BrushFactory.createBrush('local://manycolor');

            expect(b).to.be.a(BaseBrush);
            expect(b).to.be.a(LocalColor);

            const ab = BrushFactory.availableBrushes();

            expect(ab).to.be.an(Array);
            expect(ab).to.have.length(3);

            BrushFactory.deregisterBrush('local', 'manycolor');

            expect(() => {
                BrushFactory.createBrush('local://manycolor')
            }).to.throwError(/Unrecognized brush/);

            const bc = BrushFactory.availableBrushes();

            expect(bc).to.be.an(Array);
            expect(bc).to.have.length(2);
        });
    });

    describe('serialize/deserialize', () => {
        it('should work correctly', () => {
            BrushFactory.registerBrush('local', 'funkycolor', FunkyColor);
            const brush = BrushFactory.createBrush("local://funkycolor");

            const sdata = BrushFactory.serializeBrushes([brush]);

            expect(sdata).to.be.an(Array);
            expect(sdata).to.have.length(1);

            expect(sdata[0]).to.have.property('s', 'local://funkycolor');
            expect(sdata[0]).to.have.property('p');
            expect(sdata[0].p).to.have.property('testfield1', 'hi');
            expect(sdata[0].p).to.have.property('testfield2', 'by');

            const b2 = BrushFactory.deserializeBrushes(sdata);

            expect(b2).to.be.an(Array);
            expect(b2).to.have.length(1);
            expect(b2[0]).to.be.a(FunkyColor);
            expect(b2[0]).to.be.a(BaseBrush);

            expect(b2[0]).to.have.property('deserialized');
            expect(b2[0].deserialized).to.eql({testfield1: 'hi', testfield2: 'by'});

            BrushFactory.deregisterBrush('local', 'funkycolor');
        });
    })
});
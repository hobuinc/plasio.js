var webpack = require('webpack');

module.exports = {
    entry: [
        './index.js'
    ],

    resolve: {
        extensions: ['', '.js' ]
    },

    output: {
        path: './dist',
        filename: 'plasio-lib.js'
    }
};

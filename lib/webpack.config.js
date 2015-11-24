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
    },

    module: {
        loaders: [
            {
                test: /\.jsx?$/,
                exclude: /node_modules/,
                loader: 'babel',
                query: {
                    cacheDirectory: true,
                    presets: ["es2015"]
                }
            }
        ]
    }
};

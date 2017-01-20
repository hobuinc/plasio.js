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
        filename: 'plasio.js'
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
            },
            {
                test: /\.tsx?$/,
                exclude: /node_modules/,
                loader: 'ts-loader',
            }
        ]
    }
};

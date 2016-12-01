var path = require('path');

module.exports = {
  debug: true,
  devtool: 'inline-source-map',
  entry: './main.js',
  output: {
    filename: 'bundle.js',
    sourceMapFilename: 'bundle.js.map'
  },
  resolve: {
    root: [ path.resolve(__dirname, "./src") ],
    modulesDirectories: [ path.resolve(__dirname, "./node_modules") ]
  },
  module: {
    loaders: [{
      test: /\.css$/,
      loader: 'style!css'
    }]
  }
};

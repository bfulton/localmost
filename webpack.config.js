/**
 * Unified webpack configuration for electron-builder
 * Builds main process, preload script, and renderer
 */

const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

const isProduction = process.env.NODE_ENV === 'production';

// Common configuration shared across all builds
const commonConfig = {
  mode: isProduction ? 'production' : 'development',
  devtool: isProduction ? false : 'source-map',
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.json'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
          },
        },
      },
    ],
  },
};

// Main process configuration
const mainConfig = {
  ...commonConfig,
  target: 'electron-main',
  entry: './src/main/index.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'main.js',
  },
  node: {
    __dirname: false,
    __filename: false,
  },
  plugins: [
    // Inject the entry point constants that electron-forge normally provides
    new webpack.DefinePlugin({
      // Use path.join with __dirname for cross-platform compatibility
      // __dirname in packaged app points to the app.asar/dist directory
      // In dev mode, also use file:// since we don't run a dev server
      MAIN_WINDOW_WEBPACK_ENTRY: isProduction
        ? '`file://${require("path").join(__dirname, "renderer", "index.html")}`'
        : JSON.stringify(`file://${path.resolve(__dirname, 'dist/renderer/index.html')}`),
      MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: isProduction
        ? 'require("path").join(__dirname, "preload.js")'
        : JSON.stringify(path.resolve(__dirname, 'dist/preload.js')),
    }),
  ],
  // Don't bundle electron
  externals: {
    electron: 'commonjs electron',
  },
};

// Preload script configuration
// Note: Electron 20+ sandboxes preload scripts by default, so Node.js modules
// are not available. We provide empty fallbacks for modules used by dependencies
// like the 'debug' library (bundled in @zubridge/electron).
const preloadConfig = {
  ...commonConfig,
  target: 'electron-preload',
  entry: './src/main/preload.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'preload.js',
  },
  // Disable automatic Node.js externalization for sandboxed preload
  // electron-preload target uses node externals preset under the hood
  externalsPresets: { node: false, electronPreload: false },
  // Only externalize electron (which is available in preload)
  externals: {
    electron: 'commonjs electron',
  },
  resolve: {
    ...commonConfig.resolve,
    // Provide empty fallbacks for Node.js modules used by zubridge's debug dependency
    fallback: {
      fs: false,
      path: false,
      os: false,
      crypto: false,
      util: false,
      tty: false,
      // Handle node: prefix scheme (used by uuid package)
      'node:crypto': false,
    },
    // Alias process to our minimal shim (supports-color needs process.argv)
    alias: {
      process: path.resolve(__dirname, 'scripts/process-shim.js'),
    },
  },
  plugins: [
    // Handle node: scheme imports by aliasing them to non-prefixed versions
    new webpack.NormalModuleReplacementPlugin(
      /^node:/,
      (resource) => {
        resource.request = resource.request.replace(/^node:/, '');
      }
    ),
  ],
};

// Renderer process configuration
const rendererConfig = {
  ...commonConfig,
  target: 'web', // Use 'web' target for renderer with context isolation
  entry: './src/renderer/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist/renderer'),
    filename: '[name].js',
    chunkFilename: '[name].js',
    publicPath: './',
  },
  resolve: {
    ...commonConfig.resolve,
    // Provide fallbacks for Node.js modules used by zubridge
    fallback: {
      path: false,
      fs: false,
      os: false,
      crypto: false,
      buffer: false,
      stream: false,
      util: false,
      assert: false,
      http: false,
      https: false,
      zlib: false,
      url: false,
      querystring: false,
    },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
            // Override tsconfig module to preserve ES imports for tree-shaking
            compilerOptions: {
              module: 'ESNext',
            },
          },
        },
      },
      // Global CSS (non-module)
      {
        test: /\.css$/,
        exclude: /\.module\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
      // CSS Modules
      {
        test: /\.module\.css$/,
        use: [
          MiniCssExtractPlugin.loader,
          {
            loader: 'css-loader',
            options: {
              modules: {
                localIdentName: isProduction
                  ? '[hash:base64:8]'
                  : '[name]__[local]--[hash:base64:5]',
              },
            },
          },
        ],
      },
      {
        test: /\.(png|svg|jpg|jpeg|gif|ico)$/i,
        type: 'asset/resource',
      },
    ],
  },
  optimization: {
    usedExports: true,
    sideEffects: true,
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        // Split React and related libraries into a separate vendor chunk
        react: {
          test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
          name: 'vendor-react',
          chunks: 'all',
          priority: 20,
        },
        // Split FontAwesome into a separate chunk (it's large)
        fontawesome: {
          test: /[\\/]node_modules[\\/]@fortawesome[\\/]/,
          name: 'vendor-fontawesome',
          chunks: 'all',
          priority: 15,
        },
        // Other vendors
        vendors: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendors',
          chunks: 'all',
          priority: 10,
        },
      },
    },
  },
  performance: {
    maxAssetSize: 250 * 1024,
    maxEntrypointSize: 300 * 1024,
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/renderer/index.html',
      filename: 'index.html',
    }),
    new MiniCssExtractPlugin({
      filename: '[name].css',
      chunkFilename: '[name].css',
    }),
  ],
};

module.exports = [mainConfig, preloadConfig, rendererConfig];

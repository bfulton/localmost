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
const preloadConfig = {
  ...commonConfig,
  target: 'electron-preload',
  entry: './src/main/preload.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'preload.js',
  },
};

// Renderer process configuration
const rendererConfig = {
  ...commonConfig,
  target: 'web', // Use 'web' target for renderer with context isolation
  entry: './src/renderer/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist/renderer'),
    filename: 'renderer.js',
    publicPath: './',
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
  },
  performance: {
    // Desktop Electron apps load assets locally, so bundle size has minimal impact
    // These limits are appropriate for a React-based desktop app
    maxAssetSize: 500 * 1024,
    maxEntrypointSize: 600 * 1024,
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/renderer/index.html',
      filename: 'index.html',
    }),
    new MiniCssExtractPlugin({
      filename: 'styles.css',
    }),
  ],
};

module.exports = [mainConfig, preloadConfig, rendererConfig];

const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Add WASM support (required by expo-sqlite on web)
config.resolver.assetExts.push("wasm");

// whisper.rn model binary support
config.resolver.assetExts.push("bin");

// Buffer polyfill for whisper.rn
config.resolver.extraNodeModules = {
  buffer: require.resolve("buffer/"),
};

module.exports = config;

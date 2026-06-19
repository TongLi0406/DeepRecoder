const { withPlugins } = require("@expo/config-plugins");

// Expo config plugin — registers the PcmRecorder Expo Module so it gets
// linked into the native Android project during prebuild.
module.exports = function pcmRecorderPlugin(config) {
  return withPlugins(config, []);
};

const { registerPlugin, loadAll } = require('./registry');
const chat = require('./chat');
const reactions = require('./reactions');
const mute = require('./mute');
const deviceIcons = require('./deviceIcons');
const content = require('./content');
const moderation = require('./moderation');
const activity = require('./activity');
const recording = require('./recording');
const screenTimeline = require('./screenTimeline');
const privateChat = require('./privateChat');
const breakout = require('./breakout');
const whiteboard = require('./whiteboard');

function registerBuiltinPlugins() {
  registerPlugin(chat);
  registerPlugin(reactions);
  registerPlugin(mute);
  registerPlugin(deviceIcons);
  registerPlugin(content);
  registerPlugin(moderation);
  registerPlugin(activity);
  registerPlugin(recording);
  registerPlugin(screenTimeline);
  registerPlugin(privateChat);
  registerPlugin(breakout);
  registerPlugin(whiteboard);
}

module.exports = {
  registerBuiltinPlugins,
  loadAll,
  registerPlugin,
};

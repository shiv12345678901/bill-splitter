module.exports = function registerGroups(...args) {
  require("./group-list.cjs")(...args);
  require("./participants.cjs")(...args);
  require("./group-context.cjs")(...args);
};

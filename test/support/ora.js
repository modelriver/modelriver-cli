// Jest stand-in for ora (ESM-only); see test/support/chalk.js.
function ora(text) {
  const spinner = {
    text,
    start() { return spinner; },
    stop() { return spinner; },
    succeed() { return spinner; },
    fail() { return spinner; },
    warn() { return spinner; },
    info() { return spinner; },
  };
  return spinner;
}

module.exports = ora;
module.exports.default = ora;

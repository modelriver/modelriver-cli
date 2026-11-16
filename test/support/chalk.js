// Jest stand-in for chalk. Jest's module runtime can only require() ESM
// packages on Node 24.9+, and the CLI supports Node 22.12+, so tests map
// chalk to this plain CommonJS version that returns text unchanged.
function makeChalk() {
  const fn = (...args) => args.join(' ');
  return new Proxy(fn, {
    get: (_target, prop) => (prop === 'default' ? chalk : chalk),
    apply: (_target, _this, args) => args.join(' '),
  });
}

const chalk = makeChalk();

module.exports = chalk;

// Parses process.argv with the real CLI definition, but with every command
// handler replaced by a recorder, and prints what the handlers got as JSON.
// Run in a child process: commander 15 is ESM-only, which Node can require()
// but Jest cannot.
const { createProgram } = require('../../src/cli');

const calls = {};
const actions = new Proxy({}, {
  get: (_target, name) => (options) => { calls[name] = options; },
});

const program = createProgram(actions);
(function quiet(command) {
  command.exitOverride();
  command.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  command.commands.forEach(quiet);
})(program);
try {
  program.parse(process.argv);
  process.stdout.write(JSON.stringify({ calls, globals: program.opts() }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.code || error.message }));
}

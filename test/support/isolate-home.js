// Runs before every test file (jest setupFilesAfterEnv).
//
// Tests must never read or write the real ~/.modelriver: a test once
// overwrote a developer's real config.json. So for every test file:
// - MODELRIVER_CONFIG_DIR and HOME point at a new temp folder (child
//   processes the tests spawn inherit both), and MODELRIVER_* settings from
//   the shell are cleared;
// - os.homedir() throws, so nothing can fall back to the real home folder;
// - any fs call on a path inside the real ~/.modelriver throws;
// - child processes started without an env get the test's environment.
const fs = require('fs');
const os = require('os');
const path = require('path');

// A Jest worker runs this file once per test file, and core modules are
// shared, so os.homedir() may already be the guard from an earlier run.
const realHome = os.homedir.__realHome || os.homedir();
const realConfigDir = path.join(realHome, '.modelriver');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'modelriver-test-home-'));
const tempConfigDir = path.join(tempHome, '.modelriver');

// Settings from the developer's shell must not leak into tests either.
for (const name of ['MODELRIVER_API_KEY', 'MODELRIVER_API_URL', 'MODELRIVER_PROJECT_ID', 'MODELRIVER_FORWARD_URL']) {
  delete process.env[name];
}

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.MODELRIVER_CONFIG_DIR = tempConfigDir;

class RealHomeAccessError extends Error {
  constructor(what) {
    super(`Test tried to use the real home folder (${what}). Use MODELRIVER_CONFIG_DIR / the temp HOME from test/support/isolate-home.js.`);
    this.name = 'RealHomeAccessError';
  }
}

function homedirGuard() {
  throw new RealHomeAccessError('os.homedir()');
}
homedirGuard.__realHome = realHome;
os.homedir = homedirGuard;

function isInsideRealConfigDir(p) {
  if (typeof p !== 'string' && !Buffer.isBuffer(p) && !(p instanceof URL)) return false;
  let resolved;
  try {
    resolved = path.resolve(p instanceof URL ? p.pathname : String(p));
  } catch (error) {
    return false;
  }
  return resolved === realConfigDir || resolved.startsWith(realConfigDir + path.sep);
}

const PATH_ARGS = {
  // method: indexes of path arguments
  readFileSync: [0], writeFileSync: [0], appendFileSync: [0], existsSync: [0],
  statSync: [0], lstatSync: [0], openSync: [0], mkdirSync: [0], readdirSync: [0],
  chmodSync: [0], unlinkSync: [0], rmSync: [0], rmdirSync: [0], accessSync: [0],
  renameSync: [0, 1], copyFileSync: [0, 1], symlinkSync: [0, 1], linkSync: [0, 1],
  readFile: [0], writeFile: [0], appendFile: [0], stat: [0], mkdir: [0], chmod: [0],
  unlink: [0], rm: [0], rename: [0, 1], copyFile: [0, 1], open: [0], access: [0],
  createReadStream: [0], createWriteStream: [0],
};

function guard(target, label) {
  for (const [name, indexes] of Object.entries(PATH_ARGS)) {
    const original = target[name];
    if (typeof original !== 'function' || original.__realHomeGuard) continue;
    const wrapped = function guardedFsCall(...args) {
      for (const i of indexes) {
        if (isInsideRealConfigDir(args[i])) {
          throw new RealHomeAccessError(`${label}.${name}(${String(args[i])})`);
        }
      }
      return original.apply(this, args);
    };
    wrapped.__realHomeGuard = true;
    target[name] = wrapped;
  }
}

guard(fs, 'fs');
guard(fs.promises, 'fs.promises');

// In Jest, process.env above is the test's own copy: a child process started
// without an `env` option would get the worker's real environment (real HOME,
// no MODELRIVER_CONFIG_DIR) and could read or write the real ~/.modelriver.
// So every child_process call without an env gets this test's environment.
const childProcess = require('child_process');
const testProcess = process;
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = childProcess[name].__withoutTestEnv || childProcess[name];
  const wrapped = function withTestEnv(...args) {
    // Options come after the command and an optional argument array.
    const at = Array.isArray(args[1]) ? 2 : 1;
    const options = args[at];
    if (options && typeof options === 'object') {
      if (!options.env) args[at] = { ...options, env: testProcess.env };
    } else {
      args.splice(at, 0, { env: testProcess.env });
    }
    return original.apply(this, args);
  };
  wrapped.__withoutTestEnv = original;
  childProcess[name] = wrapped;
}

afterAll(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
});

module.exports = { realHome, realConfigDir, tempHome, tempConfigDir, RealHomeAccessError };

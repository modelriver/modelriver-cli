// chalk 6 and ora 10 are ESM-only. Node 22.12+ can require() them; the
// exports then sit on `.default`.
const chalkModule = require('chalk');
const oraModule = require('ora');

const chalk = chalkModule.default || chalkModule;
const ora = oraModule.default || oraModule;

class Logger {
  static success(message) {
    console.log(chalk.green(`✓ ${message}`));
  }

  static error(message) {
    console.error(chalk.red(`✗ ${message}`));
  }

  static info(message) {
    console.log(chalk.blue(`ℹ ${message}`));
  }

  static warning(message) {
    console.log(chalk.yellow(`⚠ ${message}`));
  }

  static log(message) {
    console.log(message);
  }

  static spinner(message) {
    return ora(message);
  }

  static section(title) {
    console.log(chalk.cyan.bold(`\n${title}`));
    console.log(chalk.gray('─'.repeat(title.length)));
  }
}

module.exports = Logger;

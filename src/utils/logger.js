const chalk = require('chalk');
const ora = require('ora');

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
    // Handle both CommonJS and ESM exports
    const oraInstance = typeof ora === 'function' ? ora : (ora.default || ora);
    return oraInstance(message);
  }

  static section(title) {
    console.log(chalk.cyan.bold(`\n${title}`));
    console.log(chalk.gray('─'.repeat(title.length)));
  }
}

module.exports = Logger;



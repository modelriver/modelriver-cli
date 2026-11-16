#!/usr/bin/env node

const { createProgram } = require('./cli');

const program = createProgram();
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

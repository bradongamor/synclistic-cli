const { Command } = require('commander');
const addCommand = require('./commands/add');
const listCommand = require('./commands/list');
const removeCommand = require('./commands/remove');
const syncCommand = require('./commands/sync');
const dedupeCommand = require('./commands/dedupe');
const scopesCommand = require('./commands/scopes');
const exportCommand = require('./commands/export');
const importCommand = require('./commands/import');

const VERSION = '1.0.0';

function createProgram() {
  const program = new Command();

  program
    .version(VERSION, '-v, --version', 'Output the current version')
    .description('Synclistic CLI - Manage Shopify store details')
    .helpOption('-h, --help', 'Display help for command');

  addCommand(program);
  listCommand(program);
  removeCommand(program);
  syncCommand(program);
  dedupeCommand(program);
  scopesCommand(program);
  exportCommand(program);
  importCommand(program);

  return program;
}

async function runCli(argv = process.argv) {
  const cliProgram = createProgram();
  await cliProgram.parseAsync(argv);

  if (!argv.slice(2).length) {
    cliProgram.outputHelp();
  }

  const result = cliProgram._synclisticResult;
  if (result && typeof result.exitCode === 'number') {
    process.exitCode = result.exitCode;
  }

  return result;
}

runCli().catch((error) => {
  process.exitCode = 1;
  throw error;
});

module.exports = {
  createProgram,
  runCli
};

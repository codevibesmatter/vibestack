#!/usr/bin/env node
import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import inquirer from 'inquirer';
import { createLogger } from './core/logger.ts';

// Set up global error handlers to ensure we never hang
process.on('unhandledRejection', (reason, promise) => {
  console.error('\n\n❌ Unhandled Promise Rejection:');
  console.error(reason);
  console.error('\nFORCING EXIT due to unhandled error');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('\n\n❌ Uncaught Exception:');
  console.error(error);
  console.error('\nFORCING EXIT due to uncaught exception');
  process.exit(1);
});

// Create logger
const logger = createLogger('cli');

// Calculate the directory path in ES modules (replacement for __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from the specific .env file in this directory
dotenvConfig({ path: path.resolve(__dirname, '.env') });

// Logo for the CLI
const VIBESTACK_LOGO = `
██    ██ ██ ██████ ██████ ███████ ████████  █████   ██████ ██   ██
██    ██ ██ ██   █ ██     ██         ██    ██   ██ ██      ██  ██ 
██    ██ ██ ██████ █████  ███████    ██    ███████ ██      █████  
██    ██ ██ ██   █ ██          ██    ██    ██   ██ ██      ██  ██ 
 ██████  ██ ██████ ██████ ███████    ██    ██   ██  ██████ ██   ██`;

// Define command types for better extensibility
type CommandHandler = (args: string[]) => Promise<void>;
type Command = {
  name: string;
  description: string;
  handler: CommandHandler;
  options?: { name: string; description: string; defaultValue?: string | number }[];
};

// Commands registry - easy to add new commands
const commands: Record<string, Command> = {};

// Register the live-sync command
commands['live-sync'] = {
  name: 'live-sync',
  description: 'Run a live sync test with multiple clients',
  options: [
    { name: '--clients', description: 'Number of clients to run in parallel', defaultValue: 1 },
    { name: '--count', description: 'Number of changes to create', defaultValue: 10 }
  ],
  handler: async (args: string[]) => {
    const options = parseCommandOptions(args);
    const clientCount = parseInt(options['--clients'] as string, 10) || 1;
    const changeCount = parseInt(options['--count'] as string, 10) || 10;
    
    await runLiveSyncTest(clientCount, changeCount);
  }
};

// Register the simplified-live-sync command
commands['simplified-live-sync'] = {
  name: 'simplified-live-sync',
  description: 'Run a simplified live sync test with multiple clients',
  options: [
    { name: '--clients', description: 'Number of clients to run in parallel', defaultValue: 1 },
    { name: '--count', description: 'Number of changes to create', defaultValue: 5 }
  ],
  handler: async (args: string[]) => {
    const options = parseCommandOptions(args);
    const clientCount = parseInt(options['--clients'] as string, 10) || 1;
    const changeCount = parseInt(options['--count'] as string, 10) || 5;
    
    await runSimplifiedLiveSyncTest(clientCount, changeCount);
  }
};

// Register the streamlined-live-sync command
commands['streamlined-live-sync'] = {
  name: 'streamlined-live-sync',
  description: 'Run a streamlined live sync test with the new batch changes system',
  options: [
    { name: '--clients', description: 'Number of clients to run in parallel', defaultValue: 1 },
    { name: '--count', description: 'Number of changes to create', defaultValue: 5 }
  ],
  handler: async (args: string[]) => {
    const options = parseCommandOptions(args);
    const clientCount = parseInt(options['--clients'] as string, 10) || 1;
    const changeCount = parseInt(options['--count'] as string, 10) || 5;
    
    await runStreamlinedLiveSyncTest(clientCount, changeCount);
  }
};

// Add more commands here for different test scenarios

/**
 * Parse command line options for a specific command
 */
function parseCommandOptions(args: string[]): Record<string, string | number> {
  const options: Record<string, string | number> = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      options[args[i]] = args[i + 1];
      i++; // Skip the next argument as it's the value
    }
  }
  
  return options;
}

/**
 * Run a live sync test with specified parameters
 */
async function runLiveSyncTest(clientCount: number, changeCount: number): Promise<void> {
  // Set a global timeout to ensure the process exits even if something hangs
  const globalTimeout = setTimeout(() => {
    console.error('\n⚠️ Global timeout reached! Forcing exit.');
    process.exit(1);
  }, 180000); // 3 minutes max run time
  
  try {
    // We use dynamic import to prevent auto-execution when the module is loaded
    // Fix the import: get LiveSyncScenario and ScenarioRunner instead of non-existent runLiveSyncTest
    const { LiveSyncScenario } = await import('./scenarios/live-sync.ts');
    const { ScenarioRunner } = await import('./core/scenario-runner.ts');
    
    console.log(`\n🔄 Running live sync test with ${clientCount} client(s) and ${changeCount} changes...\n`);
    
    // Create a new ScenarioRunner and configure the scenario
    const runner = new ScenarioRunner();
    const scenario = LiveSyncScenario;
    
    // Configure the scenario with our parameters
    scenario.config.customProperties = {
      ...scenario.config.customProperties,
      clientCount,
      changeCount,
      mode: 'normal'
    };
    
    // Override the default change count
    scenario.config.changeCount = changeCount;
    
    // Set high timeout for long-running tests
    scenario.config.timeout = Math.max(scenario.config.timeout || 30000, changeCount * 1000);
    
    // Run the scenario
    await runner.runScenario(scenario);
    
    console.log('\n✅ Live sync test completed successfully!');
    
    // Clear the global timeout and exit cleanly
    clearTimeout(globalTimeout);
    console.log('Test completed, exiting...');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    // Force exit immediately to avoid hanging
    clearTimeout(globalTimeout);
    process.exit(1);
  }
}

/**
 * Run a simplified live sync test with specified parameters
 */
async function runSimplifiedLiveSyncTest(clientCount: number, changeCount: number): Promise<void> {
  // Set a global timeout to ensure the process exits even if something hangs
  const globalTimeout = setTimeout(() => {
    console.error('\n⚠️ Global timeout reached! Forcing exit.');
    process.exit(1);
  }, 180000); // 3 minutes max run time
  
  try {
    // We use dynamic import to prevent auto-execution when the module is loaded
    const { LiveSyncSimplifiedScenario } = await import('./scenarios/live-sync-simplified.ts');
    const { ScenarioRunner } = await import('./core/scenario-runner.ts');
    
    console.log(`\n🔄 Running simplified live sync test with ${clientCount} client(s) and ${changeCount} changes...\n`);
    
    // Create a new ScenarioRunner and configure the scenario
    const runner = new ScenarioRunner();
    const scenario = LiveSyncSimplifiedScenario;
    
    // Configure the scenario with our parameters
    scenario.config.customProperties = {
      ...scenario.config.customProperties,
      clientCount
    };
    
    // Override the default change count
    scenario.config.changeCount = changeCount;
    
    // Set high timeout for long-running tests
    scenario.config.timeout = Math.max(scenario.config.timeout || 30000, changeCount * 1000);
    
    // Run the scenario
    await runner.runScenario(scenario);
    
    console.log('\n✅ Simplified live sync test completed successfully!');
    
    // Clear the global timeout and exit cleanly
    clearTimeout(globalTimeout);
    console.log('Test completed, exiting...');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    // Force exit immediately to avoid hanging
    clearTimeout(globalTimeout);
    process.exit(1);
  }
}

/**
 * Run a streamlined live sync test with specified parameters
 */
async function runStreamlinedLiveSyncTest(clientCount: number, changeCount: number): Promise<void> {
  // Set a global timeout to ensure the process exits even if something hangs
  const globalTimeout = setTimeout(() => {
    console.error('\n⚠️ Global timeout reached! Forcing exit.');
    process.exit(1);
  }, 180000); // 3 minutes max run time
  
  try {
    // We use dynamic import to prevent auto-execution when the module is loaded
    const { StreamlinedLiveSyncScenario } = await import('./scenarios/streamlined-live-sync.ts');
    const { ScenarioRunner } = await import('./core/scenario-runner.ts');
    
    console.log(`\n🔄 Running streamlined live sync test with ${clientCount} client(s) and ${changeCount} changes...\n`);
    
    // Create a new ScenarioRunner and configure the scenario
    const runner = new ScenarioRunner();
    const scenario = StreamlinedLiveSyncScenario;
    
    // Configure the scenario with our parameters
    scenario.config.customProperties = {
      ...scenario.config.customProperties,
      clientCount
    };
    
    // Override the default change count
    scenario.config.changeCount = changeCount;
    
    // Set high timeout for long-running tests
    scenario.config.timeout = Math.max(scenario.config.timeout || 30000, changeCount * 1000);
    
    // Run the scenario
    await runner.runScenario(scenario);
    
    console.log('\n✅ Streamlined live sync test completed successfully!');
    
    // Clear the global timeout and exit cleanly
    clearTimeout(globalTimeout);
    console.log('Test completed, exiting...');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    // Force exit immediately to avoid hanging
    clearTimeout(globalTimeout);
    process.exit(1);
  }
}

/**
 * Display help for a specific command or general help
 */
function showHelp(commandName?: string): void {
  if (commandName && commands[commandName]) {
    const command = commands[commandName];
    console.log(`\nCommand: ${command.name}`);
    console.log(`Description: ${command.description}`);
    
    if (command.options && command.options.length > 0) {
      console.log('\nOptions:');
      command.options.forEach(option => {
        const defaultValue = option.defaultValue !== undefined ? ` (default: ${option.defaultValue})` : '';
        console.log(`  ${option.name}: ${option.description}${defaultValue}`);
      });
    }
  } else {
    console.log('\nAvailable commands:');
    
    Object.values(commands).forEach(command => {
      console.log(`  ${command.name}: ${command.description}`);
    });
    
    console.log('\nUse "help <command>" for more information about a specific command.');
    console.log('Use "interactive" to start the interactive menu.');
  }
}

/**
 * Show the interactive menu
 */
async function showInteractiveMenu(): Promise<void> {
  console.clear();
  console.log(VIBESTACK_LOGO);
  console.log('Welcome to VibeStack Sync Test Suite (V2)\n');

  // Build menu options from available commands
  const choices = Object.values(commands).map(cmd => ({
    name: cmd.description,
    value: cmd.name
  }));
  
  // Add exit option
  choices.push({ name: 'Exit', value: 'exit' });

  // First level menu - choose action
  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices
    }
  ]);

  if (action === 'exit') {
    console.log('\nGoodbye! 👋');
    process.exit(0);
  }
  
  // Get the selected command
  const selectedCommand = commands[action];
  if (!selectedCommand) {
    console.log(`\n❌ Unknown command: ${action}`);
    return showInteractiveMenu();
  }
  
  // For commands with options, prompt for each option
  const commandOptions: Record<string, any> = {};
  
  if (selectedCommand.options && selectedCommand.options.length > 0) {
    const prompts = selectedCommand.options.map(option => {
      const optionName = option.name.replace(/^--/, '');
      return {
        type: 'number',
        name: optionName,
        message: `${option.description}:`,
        default: option.defaultValue,
        validate: (value: number) => value > 0 ? true : 'Please enter a positive number'
      };
    });
    
    const answers = await inquirer.prompt(prompts);
    
    // Convert to command-line format
    Object.entries(answers).forEach(([key, value]) => {
      commandOptions[`--${key}`] = value;
    });
  }
  
  // Run the command with the options
  try {
    await selectedCommand.handler(Object.entries(commandOptions).flatMap(([k, v]) => [k, v.toString()]));
    
    // Ask if they want to run another test
    const { again } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'again',
        message: 'Would you like to run another test?',
        default: false
      }
    ]);

    if (again) {
      await showInteractiveMenu();
    } else {
      console.log('\nGoodbye! 👋');
      process.exit(0);
    }
  } catch (error) {
    console.error('\n❌ Error:', error);
    
    // Ask if they want to retry
    const { retry } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'retry',
        message: 'Would you like to try again?',
        default: true
      }
    ]);
    
    if (retry) {
      await showInteractiveMenu();
    } else {
      console.log('\nGoodbye! 👋');
      process.exit(1);
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  // Register help command
  commands['help'] = {
    name: 'help',
    description: 'Display help for a command',
    handler: async (args: string[]) => {
      showHelp(args[0]);
    }
  };
  
  // Register interactive command
  commands['interactive'] = {
    name: 'interactive',
    description: 'Start the interactive menu',
    handler: async () => {
      await showInteractiveMenu();
    }
  };
  
  // Parse command line arguments
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    // No arguments, show interactive menu
    await showInteractiveMenu();
  } else {
    const commandName = args[0];
    const commandArgs = args.slice(1);
    
    // Check if command exists
    if (commands[commandName]) {
      await commands[commandName].handler(commandArgs);
    } else {
      console.log(`\n❌ Unknown command: ${commandName}`);
      showHelp();
      process.exit(1);
    }
  }
}

// Start the CLI
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
}); 
#!/usr/bin/env node
import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import inquirer from 'inquirer';
import { createLogger } from './core/logger.ts';
import { Scenario, ScenarioRunner } from './core/scenario-runner.ts';

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

// --- Scenario Definitions --- 
// Use dynamic imports within the runner function to avoid loading all scenarios upfront

// Map scenario names to their file paths and expected export names
const scenarioRegistry: Record<string, { path: string; exportName: string }> = {
  'live-sync': { path: './scenarios/live-sync.ts', exportName: 'LiveSyncScenario' },
  'client-submit': { path: './scenarios/client-submit-sync.ts', exportName: 'ClientSubmitSyncScenario' },
  'stale-client-reconnection': { path: './scenarios/stale-client-reconnection.ts', exportName: 'StaleClientReconnectionScenario' }
  // Add other scenarios here
};

/**
 * Runs a specified test scenario with given options.
 * Dynamically imports the scenario module.
 */
async function runTestScenario(scenarioName: string, cliOptions: Record<string, string | number | boolean>): Promise<void> {
  const scenarioInfo = scenarioRegistry[scenarioName];
  if (!scenarioInfo) {
    console.error(`\n❌ Unknown scenario: ${scenarioName}`);
    console.log(`Available scenarios: ${Object.keys(scenarioRegistry).join(', ')}`);
    process.exit(1);
  }

  // Set a global timeout 
  const globalTimeout = setTimeout(() => {
    console.error('\n⚠️ Global timeout reached! Forcing exit.');
    process.exit(1);
  }, 180000); // 3 minutes max run time

  try {
    // Dynamically import the scenario module
    const scenarioModule = await import(scenarioInfo.path);
    const scenario: Scenario = scenarioModule[scenarioInfo.exportName];

    if (!scenario) {
      throw new Error(`Could not load scenario object '${scenarioInfo.exportName}' from ${scenarioInfo.path}`);
    }
    
    // --- Extract CLI options with fallbacks to scenario defaults --- 
    const clientCount = parseInt(cliOptions['--clients'] as string, 10) || 
                        scenario.config.customProperties?.clientCount || 
                        2;
    const changesPerClient = parseInt(cliOptions['--changes'] as string, 10) ||
                           scenario.config.customProperties?.changesPerClient || 
                           5;
    const scenarioTimeout = parseInt(cliOptions['--timeout'] as string, 10) || 
                          scenario.config.timeout || 
                          60000;
    
    // REMOVE conflictEnabled parsing - assume always true for this scenario type
    const conflictEnabled = true; 
    
    // TODO: Add parsing for --distribution JSON string if needed

    console.log(`\n🔄 Running scenario '${scenario.name}' (${scenarioName})...`);
    console.log(`   Clients: ${clientCount}, Changes/Client: ${changesPerClient}, Conflict: ${conflictEnabled}, Timeout: ${scenarioTimeout}ms\n`);

    // Create a new ScenarioRunner
    const runner = new ScenarioRunner();

    // Configure the scenario with CLI parameters or defaults
    scenario.config.customProperties = scenario.config.customProperties || {};
    scenario.config.customProperties.clientCount = clientCount;
    scenario.config.customProperties.changesPerClient = changesPerClient;
    
    // Ensure conflictConfig exists and set enabled to true (as it's always enabled now)
    scenario.config.customProperties.conflictConfig = scenario.config.customProperties.conflictConfig || {};
    scenario.config.customProperties.conflictConfig.enabled = conflictEnabled; 
    
    // Update other config fields
    scenario.config.timeout = Math.max(scenarioTimeout, changesPerClient * clientCount * 500); 

    // Run the scenario
    await runner.runScenario(scenario);

    console.log(`\n✅ Scenario '${scenario.name}' completed successfully!`);

    // Clear the global timeout and exit cleanly
    clearTimeout(globalTimeout);
    console.log('Test completed, exiting...');
    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Scenario '${scenarioName}' failed:`, error);
    // Force exit immediately to avoid hanging
    clearTimeout(globalTimeout);
    process.exit(1);
  }
}

/**
 * Parse command line options for a specific command
 */
function parseCommandOptions(args: string[]): Record<string, string | number | boolean> {
  const options: Record<string, string | number | boolean> = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
        const key = args[i];
        // Check if it's a flag (no value follows or next arg is another option)
        if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
            options[key] = true; // Treat as boolean flag
        } else {
            // Argument has a value
            const potentialValue = args[i + 1];
            const numberValue = parseInt(potentialValue, 10);
            if (!isNaN(numberValue) && potentialValue === numberValue.toString()) {
                options[key] = numberValue; // Store as number
            } else if (potentialValue.toLowerCase() === 'true' || potentialValue.toLowerCase() === 'false') {
                options[key] = potentialValue.toLowerCase() === 'true'; // Store as boolean
            } else {
                options[key] = potentialValue; // Store as string
            }
            i++; // Skip the value argument
        }
    }
  }
  
  return options;
}

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
  
  // Simple argument parsing for direct execution
  const args = process.argv.slice(2); // Remove 'tsx' and script path
  
  if (args[0] === 'test' && args.includes('--scenario')) {
    const scenarioIndex = args.indexOf('--scenario');
    const scenarioName = args[scenarioIndex + 1];
    
    if (scenarioName) {
        // Pass all remaining args to parseCommandOptions
        const cliOptions = parseCommandOptions(args);
        await runTestScenario(scenarioName, cliOptions);
    } else {
        console.error('Missing scenario name after --scenario');
        showHelp();
        process.exit(1);
    }
  } else if (args[0] === 'help') {
     showHelp(args[1]);
     process.exit(0);
  } else if (args[0] === 'interactive' || args.length === 0) {
     await showInteractiveMenu(); 
  } else {
    console.log(`Unknown command: ${args.join(' ')}`);
    showHelp();
    process.exit(1);
  }
} // Added missing closing brace for main function

// Execute main function
main().catch(error => {
  console.error("\n❌ An unexpected error occurred in the CLI:", error);
  process.exit(1);
}); 
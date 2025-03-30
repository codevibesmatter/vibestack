// Load environment variables from .env file
import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import inquirer from 'inquirer';

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
  try {
    // We use dynamic import to prevent auto-execution when the module is loaded
    const { runLiveSyncTest } = await import('./scenarios/live-sync.ts');
    
    console.log(`\n🔄 Running live sync test with ${clientCount} client(s) and ${changeCount} changes...\n`);
    
    const results = await runLiveSyncTest(clientCount, changeCount);
    
    // Check if all tests succeeded
    const allSucceeded = results.every(r => r.success);
    if (allSucceeded) {
      console.log('\n✅ Live sync test completed successfully!');
    } else {
      console.log('\n❌ Some live sync tests failed. Check the logs above for details.');
      // Force exit with short delay to ensure logs are written
      setTimeout(() => process.exit(1), 500);
      return;
    }
    
    // Force exit after a short delay to ensure logs are written and cleanup happens
    console.log('Test completed, forcing exit in 1 second...');
    setTimeout(() => process.exit(0), 1000);
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    // Force exit with short delay to ensure logs are written
    setTimeout(() => process.exit(1), 500);
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
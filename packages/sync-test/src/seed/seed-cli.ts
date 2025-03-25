/**
 * CLI for seeding test data
 * 
 * This script provides a command-line interface for seeding the database
 * with test data in various sizes.
 */

import inquirer from 'inquirer';
import dotenv from 'dotenv';
import { 
  User, Project, Task, Comment, 
  serverEntities
} from '@repo/dataforge/server-entities';
import { seedData, clearAllData, SEED_PRESETS, SeedConfig, getDatabaseURL } from './seed-data.js';

// Load environment variables
dotenv.config();

/**
 * Format time duration in milliseconds to human readable format
 */
function formatTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

/**
 * Display a formatted summary of the seed operation
 */
function displaySummary(result: any) {
  const { metrics } = result;
  const { entityTimings } = metrics;
  
  console.log('\n✅ Seed process completed!');
  console.log('\n📊 Results Summary:');
  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│ Entity    │ Count  │  Time    │  Rate       │ % of total │');
  console.log('├───────────┼────────┼──────────┼─────────────┼────────────┤');
  
  // Calculate rates
  const userRate = (metrics.userCount / (entityTimings.users / 1000)).toFixed(1);
  const projectRate = (metrics.projectCount / (entityTimings.projects / 1000)).toFixed(1);
  const taskRate = (metrics.taskCount / (entityTimings.tasks / 1000)).toFixed(1);
  const commentRate = (metrics.commentCount / (entityTimings.comments / 1000)).toFixed(1);
  
  // Calculate percentages
  const userPerc = ((entityTimings.users / metrics.timeTaken) * 100).toFixed(1);
  const projectPerc = ((entityTimings.projects / metrics.timeTaken) * 100).toFixed(1);
  const taskPerc = ((entityTimings.tasks / metrics.timeTaken) * 100).toFixed(1);
  const commentPerc = ((entityTimings.comments / metrics.timeTaken) * 100).toFixed(1);
  
  // Format and print each entity row
  console.log(`│ Users     │ ${metrics.userCount.toString().padEnd(6)} │ ${formatTime(entityTimings.users).padEnd(8)} │ ${userRate.padEnd(9)} /s │ ${userPerc.padEnd(8)}% │`);
  console.log(`│ Projects  │ ${metrics.projectCount.toString().padEnd(6)} │ ${formatTime(entityTimings.projects).padEnd(8)} │ ${projectRate.padEnd(9)} /s │ ${projectPerc.padEnd(8)}% │`);
  console.log(`│ Tasks     │ ${metrics.taskCount.toString().padEnd(6)} │ ${formatTime(entityTimings.tasks).padEnd(8)} │ ${taskRate.padEnd(9)} /s │ ${taskPerc.padEnd(8)}% │`);
  console.log(`│ Comments  │ ${metrics.commentCount.toString().padEnd(6)} │ ${formatTime(entityTimings.comments).padEnd(8)} │ ${commentRate.padEnd(9)} /s │ ${commentPerc.padEnd(8)}% │`);
  
  console.log('├───────────┼────────┼──────────┼─────────────┼────────────┤');
  
  // Calculate entity creation rates
  const totalEntities = metrics.userCount + metrics.projectCount + metrics.taskCount + metrics.commentCount;
  const totalRate = (totalEntities / (metrics.timeTaken / 1000)).toFixed(1);
  
  console.log(`│ TOTAL     │ ${totalEntities.toString().padEnd(6)} │ ${formatTime(metrics.timeTaken).padEnd(8)} │ ${totalRate.padEnd(9)} /s │ 100.0%     │`);
  console.log('└─────────────────────────────────────────────────────────┘');
  
  // Relationships summary
  console.log('\n📈 Relationship Ratios:');
  console.log(`  • Projects per user:  ${(metrics.projectCount / metrics.userCount).toFixed(2)}`);
  console.log(`  • Tasks per project:  ${(metrics.taskCount / metrics.projectCount).toFixed(2)}`);
  console.log(`  • Comments per task:  ${(metrics.commentCount / metrics.taskCount).toFixed(2)}`);
  
  // Final timing
  console.log(`\n⏱️  Total time: ${formatTime(metrics.timeTaken)}`);
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const result: {[key: string]: string} = {};
  
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.substr(2).split('=');
      if (key && value) {
        result[key] = value;
      }
    }
  }
  
  return result;
}

// Main function
async function main() {
  console.log('==================================');
  console.log('📊 Seed Data Generator for Testing');
  console.log('==================================\n');
  
  // Parse command line arguments
  const args = parseArgs();
  
  // Get database URL
  let dbUrl: string;
  try {
    dbUrl = getDatabaseURL();
    console.log('✅ Database URL found in environment variables');
  } catch (error) {
    console.error('❌ DATABASE_URL environment variable not set');
    console.error('Please set DATABASE_URL in your .env file or environment');
    process.exit(1);
    return; // This is just for TypeScript, process.exit will stop execution
  }
  
  try {
    // If size is provided via command line, use it directly
    if (args.size && ['small', 'medium', 'large'].includes(args.size)) {
      const presetConfig = SEED_PRESETS[args.size as keyof typeof SEED_PRESETS];
      // Create a seedConfig we can modify
      const seedConfig: SeedConfig = { ...presetConfig };
      
      // If clear argument is provided, truncate tables
      if (args.clear === 'true') {
        await clearAllData(dbUrl);
      }
      
      // If client ID is provided
      if (args.clientId) {
        seedConfig.clientId = args.clientId;
      }
      
      console.log(`\n📝 Using ${args.size} preset configuration:`);
      console.log(JSON.stringify(seedConfig, null, 2));
      console.log('\n🚀 Starting seed process...');
      
      // Run seed process
      const result = await seedData(dbUrl, seedConfig);
      
      // Display formatted summary
      displaySummary(result);
    } else {
      // Get user input via prompts
      const { datasetSize, confirmClear, clientId } = await promptOptions();
      
      // If user wants to clear existing data
      if (confirmClear) {
        await clearAllData(dbUrl);
      }
      
      // Get seed config based on dataset size
      let seedConfig: SeedConfig;
      switch (datasetSize) {
        case 'small':
          seedConfig = SEED_PRESETS.small;
          break;
        case 'medium':
          seedConfig = SEED_PRESETS.medium;
          break;
        case 'large':
          seedConfig = SEED_PRESETS.large;
          break;
        case 'custom':
          seedConfig = await promptCustomConfig();
          break;
        default:
          seedConfig = SEED_PRESETS.small;
      }
      
      // Add client ID to config if provided
      if (clientId) {
        seedConfig.clientId = clientId;
      }
      
      console.log('\n📝 Seed configuration:');
      console.log(JSON.stringify(seedConfig, null, 2));
      console.log('\n🚀 Starting seed process...');
      
      // Run seed process
      const result = await seedData(dbUrl, seedConfig);
      
      // Display formatted summary
      displaySummary(result);
    }
    
  } catch (error) {
    console.error('❌ Error during seed process:', error);
  }
}

/**
 * Prompt for seed options
 */
async function promptOptions() {
  return inquirer.prompt([
    {
      type: 'list',
      name: 'datasetSize',
      message: 'Select dataset size:',
      choices: [
        { name: 'Small (25 users)', value: 'small' },
        { name: 'Medium (200 users)', value: 'medium' },
        { name: 'Large (1000 users)', value: 'large' },
        { name: 'Custom', value: 'custom' }
      ],
      default: 'small'
    },
    {
      type: 'confirm',
      name: 'confirmClear',
      message: 'Clear existing data before seeding? (uses TRUNCATE)',
      default: true
    },
    {
      type: 'input',
      name: 'clientId',
      message: 'Optional client ID to associate with entities (leave empty for none):',
      default: ''
    }
  ]);
}

/**
 * Prompt for custom configuration
 */
async function promptCustomConfig(): Promise<SeedConfig> {
  const answers = await inquirer.prompt([
    {
      type: 'number',
      name: 'userCount',
      message: 'Number of users:',
      default: 50
    },
    {
      type: 'number',
      name: 'projectsPerUser',
      message: 'Average projects per user:',
      default: 2
    },
    {
      type: 'number',
      name: 'tasksPerProject',
      message: 'Average tasks per project:',
      default: 5
    },
    {
      type: 'number',
      name: 'commentsPerTask',
      message: 'Average comments per task:',
      default: 2
    },
    {
      type: 'number',
      name: 'memberAssignmentRate',
      message: 'Project member assignment rate (0-1):',
      default: 0.5
    },
    {
      type: 'number',
      name: 'taskAssignmentRate',
      message: 'Task assignment rate (0-1):',
      default: 0.6
    },
    {
      type: 'number',
      name: 'progressInterval',
      message: 'Progress update interval (items):',
      default: 10
    }
  ]);
  
  return answers as SeedConfig;
}

// Run the main function
main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
}); 
/**
 * Comprehensive test runner for GitHub contribution analysis functions
 * 
 * Usage:
 * - Run just the report generation: node test-runner.js generate
 * - Run user report: node test-runner.js user USERNAME
 * - Run lastweek report: node test-runner.js lastweek
 * - Run with specific optimization flags: MEMORY_OPTIMIZED=true MAX_REPOS=2 node test-runner.js generate
 */
const githubController = require('./src/controllers/githubController');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

// Load environment variables
dotenv.config();

// Setup mock Slack client
const mockClient = {
  chat: {
    postMessage: async (params) => {
      console.log('\n===== MOCK SLACK MESSAGE =====');
      console.log('Channel:', params.channel);
      console.log('Text:', params.text || 'No text, using blocks');
      if (params.blocks) {
        console.log('Blocks:', JSON.stringify(params.blocks, null, 2));
      }
      console.log('==============================\n');
      return { ok: true };
    }
  }
};

// Setup mock respond function
const mockRespond = async (params) => {
  console.log('\n===== MOCK SLACK RESPONSE =====');
  console.log(JSON.stringify(params, null, 2));
  console.log('===============================\n');
  return { ok: true };
};

// Connect to MongoDB if needed
async function connectToDatabase() {
  if (process.env.MONGODB_URI) {
    try {
      console.log('Connecting to MongoDB...');
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('Connected to MongoDB successfully');
      return true;
    } catch (error) {
      console.error('Error connecting to MongoDB:', error);
      return false;
    }
  } else {
    console.log('No MongoDB URI provided, skipping database connection');
    return false;
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0] || 'generate';
const additionalArgs = args.slice(1);

// Run the test
async function runTest() {
  let dbConnected = false;
  
  try {
    // Connect to database
    dbConnected = await connectToDatabase();
    
    console.log(`Starting test of "${command}" command with args:`, additionalArgs);
    
    // Setup default optimization flags for testing
    if (!process.env.MEMORY_OPTIMIZED) {
      process.env.MEMORY_OPTIMIZED = 'true';
    }
    if (!process.env.MAX_REPOS) {
      process.env.MAX_REPOS = '1'; // Only process 1 repo for faster testing
    }
    
    // Log active optimizations
    console.log('Running with optimizations:');
    console.log('- MEMORY_OPTIMIZED:', process.env.MEMORY_OPTIMIZED);
    console.log('- MAX_REPOS:', process.env.MAX_REPOS);
    console.log('- SKIP_DETAILED_CONTENT:', process.env.SKIP_DETAILED_CONTENT);
    console.log('- SKIP_AI_ANALYSIS:', process.env.SKIP_AI_ANALYSIS);
    
    // Common parameters
    const baseParams = {
      userId: 'test-user',
      teamId: 'test-team',
      channelId: 'test-channel',
      respond: mockRespond,
      client: mockClient
    };
    
    // Run the appropriate command
    switch (command.toLowerCase()) {
      case 'generate':
        console.log('Running handleGenerateReport');
        await githubController.handleGenerateReport({
          ...baseParams,
          args: ['generate', ...additionalArgs]
        });
        break;
        
      case 'user':
        console.log('Running handleUserReport');
        if (additionalArgs.length === 0) {
          console.error('Error: Username required for user command');
          console.log('Usage: node test-runner.js user USERNAME');
          process.exit(1);
        }
        await githubController.handleUserReport({
          ...baseParams,
          args: ['user', additionalArgs[0]]
        });
        break;
        
      case 'lastweek':
        console.log('Running handleLastWeekReport');
        await githubController.handleLastWeekReport({
          ...baseParams,
          args: ['lastweek']
        });
        break;
        
      case 'token':
        console.log('Running handleTokenInfo');
        await githubController.handleTokenInfo({
          respond: mockRespond
        });
        break;
        
      case 'raw':
        // Directly run generateContributionReport for raw performance testing
        console.time('Raw report generation');
        const report = await githubController.generateContributionReport();
        console.timeEnd('Raw report generation');
        console.log('Report summary:');
        console.log('- Total commits:', report.summary.totalCommits);
        console.log('- Total PRs:', report.summary.totalPRs);
        console.log('- Total issues:', report.summary.totalIssues);
        console.log('- Users:', Object.keys(report.users).length);
        break;
        
      default:
        console.error(`Unknown command: ${command}`);
        console.log('Available commands: generate, user, lastweek, raw');
        process.exit(1);
    }
    
    console.log('\nTest completed successfully');
  } catch (error) {
    console.error('\nTest failed with error:', error);
  } finally {
    // Close MongoDB connection if it was opened
    if (dbConnected && mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
      console.log('Closed MongoDB connection');
    }
    
    // Exit the process with a delay to allow background tasks to complete
    setTimeout(() => {
      console.log('Exiting test script');
      process.exit(0);
    }, 2000);
  }
}

// Run the test
runTest(); 
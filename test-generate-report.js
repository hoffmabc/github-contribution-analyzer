/**
 * Test script to run the handleGenerateReport function locally
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
      console.log('Mock Slack message posted to channel:', params.channel);
      console.log('Message blocks:', JSON.stringify(params.blocks, null, 2));
      return { ok: true };
    }
  }
};

// Setup mock respond function
const mockRespond = async (params) => {
  console.log('Respond called with:', JSON.stringify(params, null, 2));
  return { ok: true };
};

// Connect to MongoDB if needed
async function connectToDatabase() {
  if (process.env.MONGODB_URI) {
    try {
      console.log('Connecting to MongoDB...');
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('Connected to MongoDB successfully');
    } catch (error) {
      console.error('Error connecting to MongoDB:', error);
      // Continue without DB connection - the test can still run without saving reports
    }
  } else {
    console.log('No MongoDB URI provided, skipping database connection');
  }
}

// Run the test
async function runTest() {
  try {
    await connectToDatabase();
    
    console.log('Starting test of handleGenerateReport...');
    
    // Set optimization flags for testing
    process.env.MEMORY_OPTIMIZED = 'true';
    process.env.MAX_REPOS = '1'; // Only process 1 repo for faster testing
    
    // Test parameters
    const testParams = {
      args: ['generate'],
      userId: 'test-user',
      teamId: 'test-team',
      channelId: 'test-channel',
      respond: mockRespond,
      client: mockClient
    };
    
    // Run the function
    await githubController.handleGenerateReport(testParams);
    
    console.log('Test completed successfully');
  } catch (error) {
    console.error('Test failed with error:', error);
  } finally {
    // Close MongoDB connection
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
      console.log('Closed MongoDB connection');
    }
    
    // Exit after 2 seconds to allow any background tasks to complete
    setTimeout(() => {
      console.log('Exiting test script');
      process.exit(0);
    }, 2000);
  }
}

// Run the test
runTest(); 
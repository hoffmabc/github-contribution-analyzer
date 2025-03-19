const { App, ExpressReceiver } = require('@slack/bolt');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cron = require('cron');
const githubController = require('./controllers/githubController');
const interactivityController = require('./controllers/interactivityController');

// Load environment variables
dotenv.config();

// Get port from environment
const PORT = parseInt(process.env.PORT || '3000', 10);

// Print environment details for debugging (without exposing sensitive values)
console.log('=== APPLICATION STARTUP ===');
console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`PORT: ${PORT}`);
console.log(`SLACK_BOT_TOKEN exists: ${!!process.env.SLACK_BOT_TOKEN}`);
console.log(`SLACK_SIGNING_SECRET exists: ${!!process.env.SLACK_SIGNING_SECRET}`);
console.log(`SLACK_APP_TOKEN exists: ${!!process.env.SLACK_APP_TOKEN}`);
console.log(`MONGODB_URI exists: ${!!process.env.MONGODB_URI}`);
console.log(`GITHUB_TOKEN exists: ${!!process.env.GITHUB_TOKEN}`);

// Function to sanitize tokens
function sanitizeToken(token) {
  if (!token) return undefined;
  
  // Trim whitespace
  let sanitized = token.trim();
  
  // Check for trailing newlines or other invisible characters
  if (sanitized.includes('\n')) {
    console.log('WARNING: Token contains newline characters - sanitizing...');
    sanitized = sanitized.replace(/[\n\r]/g, '');
  }
  
  if (sanitized.length === 0) {
    console.log('WARNING: Token is empty after sanitization');
    return undefined;
  }
  
  return sanitized;
}

// Safely get environment variables
const slackBotToken = sanitizeToken(process.env.SLACK_BOT_TOKEN);
const slackSigningSecret = sanitizeToken(process.env.SLACK_SIGNING_SECRET);
const slackAppToken = sanitizeToken(process.env.SLACK_APP_TOKEN);
const mongoUri = sanitizeToken(process.env.MONGODB_URI);
const githubToken = sanitizeToken(process.env.GITHUB_TOKEN);

// Create a custom receiver
const receiver = new ExpressReceiver({ 
  signingSecret: slackSigningSecret,
  processBeforeResponse: true
});

// Add debugging route
receiver.router.get('/', (req, res) => {
  // Don't include tokens in logs - just log that we have them
  console.log('Environment check:');
  console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(`PORT: ${process.env.PORT}`);
  console.log(`SLACK_BOT_TOKEN exists: ${!!slackBotToken}, length: ${slackBotToken ? slackBotToken.length : 0}`);
  console.log(`SLACK_SIGNING_SECRET exists: ${!!slackSigningSecret}, length: ${slackSigningSecret ? slackSigningSecret.length : 0}`);
  console.log(`SLACK_APP_TOKEN exists: ${!!slackAppToken}, length: ${slackAppToken ? slackAppToken.length : 0}`);
  console.log(`MONGODB_URI exists: ${!!mongoUri}, length: ${mongoUri ? mongoUri.length : 0}`);
  console.log(`GITHUB_TOKEN exists: ${!!githubToken}, length: ${githubToken ? githubToken.length : 0}`);
  
  res.status(200).send('GitHub Contribution Analysis Bot is running! Check logs for environment details.');
});

// Add a route for health checks
receiver.router.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Initialize the Slack app with the custom receiver
let app;
try {
  app = new App({
    token: slackBotToken,
    receiver,
    // Only use Socket Mode for local development
    socketMode: process.env.NODE_ENV !== 'production',
    appToken: process.env.NODE_ENV !== 'production' ? slackAppToken : undefined,
  });
  console.log('Slack app initialized successfully');
} catch (error) {
  console.error('Failed to initialize Slack app:', error);
  process.exit(1);
}

// Connect to MongoDB
console.log(`Connecting to MongoDB with URI length: ${mongoUri ? mongoUri.length : 0}`);
mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  retryWrites: true,
  w: 'majority',
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => {
  console.error('MongoDB connection error:', err);
  // Don't exit in production - we should try to handle errors gracefully
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
});

// Register Slack commands with better error handling
try {
  app.command('/review', async ({ command, ack, respond, client }) => {
    try {
      // Only acknowledge ONCE, here
      await ack();
      
      // Pass an object WITHOUT ack to the handler function
      await githubController.handleReviewCommand({ 
        command, 
        respond, 
        client 
        // Removed ack from here
      });
    } catch (error) {
      console.error('Error handling /review command:', error);
      try {
        await respond({
          text: 'An error occurred while processing your command. Please try again.',
          response_type: 'ephemeral'
        });
      } catch (responseError) {
        console.error('Error sending error response:', responseError);
      }
    }
  });
  console.log('Registered /review command handler');
} catch (error) {
  console.error('Failed to register command handler:', error);
}

// Register interactivity handlers with better error handling
try {
  app.action('view_details', async (args) => {
    try {
      await interactivityController.handleInteractivity(args);
    } catch (error) {
      console.error('Error handling view_details action:', error);
    }
  });
  console.log('Registered view_details action handler');
} catch (error) {
  console.error('Failed to register action handler:', error);
}

// Create an endpoint for manual GitHub contribution analysis
receiver.router.post('/api/analyze-contributions', async (req, res) => {
  try {
    const report = await githubController.generateContributionReport();
    res.status(200).json({ success: true, report });
  } catch (error) {
    console.error('Error analyzing GitHub contributions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Setup weekly report cron job
let weeklyReportJob;
if (process.env.ENABLE_WEEKLY_REPORTS === 'true') {
  weeklyReportJob = new cron.CronJob(
    process.env.WEEKLY_REPORT_CRON || '0 9 * * 1', // Default: Mondays at 9 AM
    async () => {
      try {
        await githubController.sendWeeklyReport();
        console.log('Weekly GitHub contribution report sent successfully');
      } catch (error) {
        console.error('Error sending weekly GitHub report:', error);
      }
    },
    null,
    false, // Don't start automatically
    'UTC'
  );
}

// Start the app
(async () => {
  await app.start(PORT);
  console.log(`⚡️ GitHub Contribution Analysis Bot is running on port ${PORT}!`);
  
  // Start the cron job if enabled
  if (weeklyReportJob && process.env.ENABLE_WEEKLY_REPORTS === 'true') {
    weeklyReportJob.start();
    console.log('Weekly GitHub report job started');
  }
})();

// Handle shutdown
process.on('SIGINT', async () => {
  if (weeklyReportJob) {
    weeklyReportJob.stop();
  }
  await mongoose.disconnect();
  process.exit(0);
}); 
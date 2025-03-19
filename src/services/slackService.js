const { App } = require('@slack/bolt');
const Settings = require('../models/Settings');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Function to sanitize tokens
function sanitizeToken(token) {
  if (!token) return undefined;
  
  // Trim whitespace and remove any quotes
  let sanitized = token.trim();
  
  // Remove any leading/trailing quotes that might be causing issues
  if ((sanitized.startsWith('"') && sanitized.endsWith('"')) || 
      (sanitized.startsWith("'") && sanitized.endsWith("'"))) {
    sanitized = sanitized.substring(1, sanitized.length - 1);
  }
  
  // Check for and remove newlines
  if (sanitized.includes('\n') || sanitized.includes('\r')) {
    console.log('WARNING: Token contains newline characters - sanitizing...');
    sanitized = sanitized.replace(/[\n\r]/g, '');
  }
  
  // Check for and remove any null bytes or other control characters
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');
  
  if (sanitized.length === 0) {
    console.log('WARNING: Token is empty after sanitization');
    return undefined;
  }
  
  // Verify the token doesn't contain problematic characters for HTTP headers
  const invalidHeaderChars = /[^\t\x20-\x7E\x80-\xFF]/;
  if (invalidHeaderChars.test(sanitized)) {
    console.log('WARNING: Token contains invalid characters for HTTP headers - sanitizing...');
    sanitized = sanitized.replace(invalidHeaderChars, '');
  }
  
  return sanitized;
}

// Safely get Slack token
const slackBotToken = sanitizeToken(process.env.SLACK_BOT_TOKEN);
if (!slackBotToken) {
  console.error('SLACK_BOT_TOKEN is missing or invalid! Slack functionality will not work properly.');
} else {
  console.log(`SLACK_BOT_TOKEN length: ${slackBotToken.length}`);
}

// Create a map to cache clients by channel
const clientCache = new Map();

// Initialize the Slack client with better error handling
let client;
try {
  client = new App({
    token: slackBotToken,
    signingSecret: sanitizeToken(process.env.SLACK_SIGNING_SECRET)
  }).client;
  
  console.log('Slack client initialized successfully');
} catch (error) {
  console.error('Failed to initialize Slack client:', error);
  // Create a placeholder client object that will log errors instead of crashing
  client = {
    chat: {
      postMessage: async () => {
        console.error('Slack client not properly initialized. Message not sent.');
        return { ok: false, error: 'Slack client not initialized' };
      },
      postEphemeral: async () => {
        console.error('Slack client not properly initialized. Ephemeral message not sent.');
        return { ok: false, error: 'Slack client not initialized' };
      },
      update: async () => {
        console.error('Slack client not properly initialized. Message not updated.');
        return { ok: false, error: 'Slack client not initialized' };
      }
    }
  };
}

/**
 * Get client and settings for a specific channel
 */
async function getClientAndSettings(channelId) {
  // If we already have a client for this channel in cache, use it
  if (clientCache.has(channelId)) {
    return clientCache.get(channelId);
  }
  
  // Get settings for this team
  const settings = await Settings.getForTeam(channelId);
  
  // Cache the client and settings
  const result = { client, settings };
  clientCache.set(channelId, result);
  
  return result;
}

/**
 * Post a simple message to a channel
 */
async function postMessage(channelId, text, blocks = []) {
  try {
    const result = await client.chat.postMessage({
      channel: channelId,
      text,
      blocks: blocks.length > 0 ? blocks : undefined
    });
    
    return result;
  } catch (error) {
    console.error('Error posting message to Slack:', error);
    throw error;
  }
}

/**
 * Update a message in a channel
 */
async function updateMessage(channelId, messageTs, text, blocks = []) {
  try {
    const result = await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text,
      blocks: blocks.length > 0 ? blocks : undefined
    });
    
    return result;
  } catch (error) {
    console.error('Error updating Slack message:', error);
    throw error;
  }
}

/**
 * Send an ephemeral message visible only to a specific user
 */
async function sendEphemeralMessage(channelId, userId, text, blocks = []) {
  try {
    const result = await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text,
      blocks: blocks.length > 0 ? blocks : undefined
    });
    
    return result;
  } catch (error) {
    console.error('Error sending ephemeral message:', error);
    throw error;
  }
}

/**
 * Post a GitHub contribution report to a channel
 */
async function postContributionReport(channelId, report, reportId) {
  const { startDate, endDate } = report.summary.period;
  const formattedStartDate = new Date(startDate).toLocaleDateString();
  const formattedEndDate = new Date(endDate).toLocaleDateString();
  
  // Simple text fallback
  let text = `*GitHub Contribution Report*\n`;
  text += `*Period:* ${formattedStartDate} to ${formattedEndDate}\n\n`;
  text += `*Summary:*\n`;
  text += `• Total Commits: ${report.summary.totalCommits}\n`;
  text += `• Total Pull Requests: ${report.summary.totalPRs}\n`;
  text += `• Total Issues: ${report.summary.totalIssues}\n`;
  
  // Create rich message blocks
  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "GitHub Contribution Report",
        emoji: true
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Period:* ${formattedStartDate} to ${formattedEndDate}`
      }
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Total Commits:*\n${report.summary.totalCommits}`
        },
        {
          type: "mrkdwn",
          text: `*Total Pull Requests:*\n${report.summary.totalPRs}`
        },
        {
          type: "mrkdwn",
          text: `*Total Issues:*\n${report.summary.totalIssues}`
        },
        {
          type: "mrkdwn",
          text: `*Repositories:*\n${report.summary.repositories.length}`
        }
      ]
    }
  ];
  
  // Add sections for top contributors
  if (Object.keys(report.users).length > 0) {
    blocks.push({
      type: "divider"
    });
    
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Top Contributors*"
      }
    });
    
    // Rank users by activity score
    const topUsers = Object.entries(report.users)
      .map(([username, data]) => ({ username, ...data }))
      .sort((a, b) => b.activityScore - a.activityScore)
      .slice(0, 5); // Top 5 users
    
    for (const user of topUsers) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${user.username}*\nCommits: ${user.totalCommits} | PRs: ${user.totalPRs} | Issues: ${user.totalIssues}`
        },
        accessory: {
          type: "button",
          text: {
            type: "plain_text",
            text: "Details",
            emoji: true
          },
          value: `user_${user.username}_${reportId}`,
          action_id: "view_details"
        }
      });
    }
    
    // Add button to see all contributors
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "View All Contributors",
            emoji: true
          },
          value: `all_${reportId}`,
          action_id: "view_details"
        }
      ]
    });
  }
  
  return await postMessage(channelId, text, blocks);
}

/**
 * Send a message to the channel about a new review request
 */
async function sendReviewRequestMessage({ client, channelId, reviewId, requesterName, reviewerName, prUrl }) {
  try {
    const result = await client.chat.postMessage({
      channel: channelId,
      text: `${requesterName} has requested a code review from ${reviewerName}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Code Review Request*\n${requesterName} has requested a code review from ${reviewerName}`
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Pull Request:* <${prUrl}|View PR>`
          }
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Requested at: ${new Date().toLocaleString()}`
            }
          ]
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Mark as Completed",
                emoji: true
              },
              value: `complete_${reviewId}`,
              action_id: "complete_review"
            }
          ]
        }
      ]
    });
    
    return result;
  } catch (error) {
    console.error('Error sending review request message:', error);
    throw error;
  }
}

/**
 * Update an existing review message in the channel
 */
async function updateReviewMessage({ client, channelId, messageTs, status, reviewId, requesterName, reviewerName, prUrl, completedAt }) {
  try {
    let statusText, statusColor;
    
    if (status === 'completed') {
      statusText = `✅ ${reviewerName} completed this review on ${completedAt.toLocaleString()}`;
      statusColor = "#36a64f";
    } else if (status === 'cancelled') {
      statusText = `🚫 This review request was cancelled`;
      statusColor = "#ff0000";
    }
    
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: `${requesterName} requested a code review from ${reviewerName} - Status: ${status}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Code Review Request*\n${requesterName} requested a code review from ${reviewerName}`
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Pull Request:* <${prUrl}|View PR>`
          }
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: statusText
            }
          ]
        }
      ]
    });
  } catch (error) {
    console.error('Error updating review message:', error);
    // Don't rethrow, just log the error since this isn't critical
  }
}

/**
 * Send a direct message to the reviewer about a new review request
 */
async function notifyReviewer({ client, reviewerId, requesterName, prUrl }) {
  try {
    await client.chat.postMessage({
      channel: reviewerId,
      text: `You have a new code review request from ${requesterName}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*You have a new code review request*\n${requesterName} has requested your review on a pull request.`
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Pull Request:* <${prUrl}|View PR>`
          }
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Use \`/review complete ${prUrl}\` when you've completed the review.`
            }
          ]
        }
      ]
    });
  } catch (error) {
    console.error('Error notifying reviewer:', error);
    // Don't rethrow, just log the error since this isn't critical
  }
}

/**
 * Send a reminder message to the reviewer
 */
async function sendReminderMessage({ client, reviewerId, requesterName, prUrl, message, isManual }) {
  try {
    const reminderSource = isManual ? 
      `${requesterName} manually sent this reminder` : 
      'This is an automated reminder';
    
    await client.chat.postMessage({
      channel: reviewerId,
      text: `Reminder: You have a pending code review from ${requesterName}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Reminder: Pending Code Review*\n${message}`
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Pull Request:* <${prUrl}|View PR>\n*Requested by:* ${requesterName}`
          }
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: reminderSource
            }
          ]
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Use \`/review complete ${prUrl}\` when you've completed the review.`
            }
          ]
        }
      ]
    });
  } catch (error) {
    console.error('Error sending reminder:', error);
    // Don't rethrow, just log the error since this isn't critical
  }
}

/**
 * Send a thank you message to the reviewer
 */
async function sendThankYouMessage({ client, userId, message }) {
  try {
    await client.chat.postMessage({
      channel: userId,
      text: message,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${message}*`
          }
        }
      ]
    });
  } catch (error) {
    console.error('Error sending thank you message:', error);
    // Don't rethrow, just log the error since this isn't critical
  }
}

/**
 * Notify requester that their review was completed
 */
async function notifyRequesterOfCompletion({ client, requesterId, reviewerName, prUrl }) {
  try {
    await client.chat.postMessage({
      channel: requesterId,
      text: `${reviewerName} has completed your code review`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Code Review Completed*\n${reviewerName} has completed the review you requested.`
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Pull Request:* <${prUrl}|View PR>`
          }
        }
      ]
    });
  } catch (error) {
    console.error('Error notifying requester of completion:', error);
    // Don't rethrow, just log the error since this isn't critical
  }
}

/**
 * Notify reviewer that a review was cancelled
 */
async function notifyReviewerOfCancellation({ client, reviewerId, requesterName, prUrl }) {
  try {
    await client.chat.postMessage({
      channel: reviewerId,
      text: `${requesterName} has cancelled their code review request`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Code Review Request Cancelled*\n${requesterName} has cancelled their review request.`
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Pull Request:* <${prUrl}|View PR>`
          }
        }
      ]
    });
  } catch (error) {
    console.error('Error notifying reviewer of cancellation:', error);
    // Don't rethrow, just log the error since this isn't critical
  }
}

module.exports = {
  client,
  getClientAndSettings,
  postMessage,
  updateMessage,
  sendEphemeralMessage,
  postContributionReport,
  sendReviewRequestMessage,
  updateReviewMessage,
  notifyReviewer,
  sendReminderMessage,
  sendThankYouMessage,
  notifyRequesterOfCompletion,
  notifyReviewerOfCancellation
}; 
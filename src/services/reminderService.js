const Review = require('../models/Review');
const Settings = require('../models/Settings');
const slackService = require('./slackService');

/**
 * Send reminders for pending reviews
 */
async function sendReminders() {
  try {
    // Get all pending reviews grouped by team
    const pendingReviews = await Review.find({ status: 'pending' });
    
    // Group reviews by teamId
    const reviewsByTeam = {};
    for (const review of pendingReviews) {
      // Get the client from Slack App
      const { client, settings } = await slackService.getClientAndSettings(review.channelId);
      
      if (!settings.reminderEnabled) {
        continue; // Skip if reminders are disabled for this team
      }
      
      // Check if review needs a reminder based on team settings
      const needsReminder = checkIfNeedsReminder(review, settings);
      
      if (needsReminder) {
        // Fetch requester info
        const requesterInfo = await client.users.info({ user: review.requesterId });
        const requesterName = requesterInfo.user.real_name || requesterInfo.user.name;
        
        // Send reminder
        await slackService.sendReminderMessage({
          client,
          reviewerId: review.reviewerId,
          requesterName,
          prUrl: review.prUrl,
          message: settings.reminderMessage,
          isManual: false
        });
        
        // Update the review with new reminder information
        await review.updateReminder();
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error sending reminders:', error);
    throw error;
  }
}

/**
 * Check if a review needs a reminder based on settings
 */
function checkIfNeedsReminder(review, settings) {
  // If review has reached the maximum number of reminders, don't send more
  if (review.reminderCount >= settings.reminderLimit) {
    return false;
  }
  
  // Calculate the time threshold for sending a new reminder
  const threshold = new Date();
  threshold.setHours(threshold.getHours() - settings.reminderFrequencyHours);
  
  // Check if it's been long enough since the last reminder (or the initial request)
  const lastReminderOrRequest = review.lastReminderSent || review.requestedAt;
  return new Date(lastReminderOrRequest) < threshold;
}

module.exports = {
  sendReminders
}; 
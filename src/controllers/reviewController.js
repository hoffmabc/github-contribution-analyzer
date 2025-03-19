const Review = require('../models/Review');
const Settings = require('../models/Settings');
const slackService = require('../services/slackService');
const { validatePrUrl } = require('../utils/validators');
const { parseUserId, usernameToId } = require('../utils/slackHelpers');

/**
 * Handle all /review commands
 */
async function handleReviewCommand({ command, ack, respond, client }) {
  try {
    // Acknowledge the command request
    await ack();
    
    const { text, user_id, team_id, channel_id } = command;
    const args = text.trim().split(' ');
    const subCommand = args[0].toLowerCase();
    
    // Route to the appropriate sub-command handler
    switch (subCommand) {
      case 'request':
        await handleRequestReview({ args, userId: user_id, teamId: team_id, channelId: channel_id, respond, client });
        break;
      case 'list':
        await handleListReviews({ userId: user_id, teamId: team_id, respond, client });
        break;
      case 'complete':
        await handleCompleteReview({ args, userId: user_id, teamId: team_id, respond, client });
        break;
      case 'cancel':
        await handleCancelReview({ args, userId: user_id, teamId: team_id, respond, client });
        break;
      case 'remind':
        await handleManualReminder({ args, userId: user_id, teamId: team_id, respond, client });
        break;
      case 'settings':
        await handleSettings({ args, userId: user_id, teamId: team_id, respond, client });
        break;
      case 'help':
      default:
        await showHelp(respond);
        break;
    }
  } catch (error) {
    console.error('Error handling review command:', error);
    await respond({
      text: 'An error occurred while processing your command. Please try again.',
      response_type: 'ephemeral'
    });
  }
}

/**
 * Handle /review request @user PR_URL
 */
async function handleRequestReview({ args, userId, teamId, channelId, respond, client }) {
  // Check if we have enough arguments
  if (args.length < 3) {
    return await respond({
      text: 'Missing arguments. Usage: `/review request @user PR_URL`',
      response_type: 'ephemeral'
    });
  }
  
  // Extract reviewer and PR URL
  const reviewerMention = args[1];
  const prUrl = args[2];
  
  // Validate the PR URL
  if (!validatePrUrl(prUrl)) {
    return await respond({
      text: 'Invalid PR URL. Please provide a valid GitHub/GitLab/Bitbucket PR URL.',
      response_type: 'ephemeral'
    });
  }
  
  // Extract reviewer ID from mention
  let reviewerId = parseUserId(reviewerMention);
  
  // If the result starts with LOOKUP:, we need to convert username to ID
  if (reviewerId && reviewerId.startsWith('LOOKUP:')) {
    const username = reviewerId.substring(7); // Remove "LOOKUP:" prefix
    console.log(`Looking up user ID for username: ${username}`);
    reviewerId = await usernameToId(username, client);
  }
  
  if (!reviewerId) {
    return await respond({
      text: 'Invalid user mention. Please use @username to mention the reviewer.',
      response_type: 'ephemeral'
    });
  }
  
  try {
    // Get user info for requester and reviewer
    const requesterInfo = await client.users.info({ user: userId });
    const reviewerInfo = await client.users.info({ user: reviewerId });
    
    // Create a new review request
    const review = new Review({
      requesterId: userId,
      requesterName: requesterInfo.user.real_name || requesterInfo.user.name,
      reviewerId: reviewerId,
      reviewerName: reviewerInfo.user.real_name || reviewerInfo.user.name,
      prUrl: prUrl,
      channelId: channelId
    });
    
    await review.save();
    
    // Send a message to the channel
    const message = await slackService.sendReviewRequestMessage({
      client,
      channelId,
      reviewId: review._id,
      requesterName: review.requesterName,
      reviewerName: review.reviewerName,
      prUrl: review.prUrl
    });
    
    // Update the review with the message timestamp for updating later
    if (message && message.ts) {
      review.messageTs = message.ts;
      await review.save();
    }
    
    // Notify the reviewer in a direct message
    await slackService.notifyReviewer({
      client,
      reviewerId,
      requesterName: review.requesterName,
      prUrl: review.prUrl
    });
    
    // Respond to the command with confirmation
    await respond({
      text: `Review request sent to ${reviewerInfo.user.real_name || reviewerInfo.user.name}`,
      response_type: 'ephemeral'
    });
  } catch (error) {
    console.error('Error requesting review:', error);
    await respond({
      text: 'An error occurred while requesting the review. Please try again.',
      response_type: 'ephemeral'
    });
  }
}

/**
 * Handle /review list
 */
async function handleListReviews({ userId, teamId, respond, client }) {
  try {
    // Fetch reviews where the user is either a requester or reviewer
    const requestedReviews = await Review.find({ 
      requesterId: userId, 
      status: 'pending' 
    }).sort({ requestedAt: -1 });
    
    const pendingReviews = await Review.findPendingForUser(userId);
    
    // Format the response
    let responseText = '*Your Code Review Summary*\n\n';
    
    if (pendingReviews.length === 0 && requestedReviews.length === 0) {
      responseText += 'You have no pending code reviews.';
    } else {
      if (pendingReviews.length > 0) {
        responseText += '*Reviews you need to do:*\n';
        pendingReviews.forEach((review, index) => {
          const daysAgo = Math.floor((new Date() - new Date(review.requestedAt)) / (1000 * 60 * 60 * 24));
          responseText += `${index + 1}. From *${review.requesterName}* - <${review.prUrl}|View PR> - Requested ${daysAgo} day(s) ago\n`;
        });
      }
      
      if (requestedReviews.length > 0) {
        if (pendingReviews.length > 0) responseText += '\n';
        responseText += '*Reviews you requested:*\n';
        requestedReviews.forEach((review, index) => {
          const daysAgo = Math.floor((new Date() - new Date(review.requestedAt)) / (1000 * 60 * 60 * 24));
          responseText += `${index + 1}. For *${review.reviewerName}* - <${review.prUrl}|View PR> - Requested ${daysAgo} day(s) ago\n`;
        });
      }
    }
    
    await respond({
      text: responseText,
      response_type: 'ephemeral'
    });
  } catch (error) {
    console.error('Error listing reviews:', error);
    await respond({
      text: 'An error occurred while fetching your reviews. Please try again.',
      response_type: 'ephemeral'
    });
  }
}

/**
 * Handle /review complete PR_URL
 */
async function handleCompleteReview({ args, userId, teamId, respond, client }) {
  if (args.length < 2) {
    return await respond({
      text: 'Missing PR URL. Usage: `/review complete PR_URL`',
      response_type: 'ephemeral'
    });
  }
  
  const prUrl = args[1];
  
  try {
    // Find the review
    const review = await Review.findOne({ 
      prUrl, 
      reviewerId: userId,
      status: 'pending'
    });
    
    if (!review) {
      return await respond({
        text: 'No pending review found for this PR URL.',
        response_type: 'ephemeral'
      });
    }
    
    // Mark as completed
    await review.markAsCompleted();
    
    // Update the message in the channel
    if (review.channelId && review.messageTs) {
      await slackService.updateReviewMessage({
        client,
        channelId: review.channelId,
        messageTs: review.messageTs,
        status: 'completed',
        reviewId: review._id,
        requesterName: review.requesterName,
        reviewerName: review.reviewerName,
        prUrl: review.prUrl,
        completedAt: review.completedAt
      });
    }
    
    // Send thank you message to the reviewer
    const settings = await Settings.getForTeam(teamId);
    await slackService.sendThankYouMessage({
      client,
      userId: review.reviewerId,
      message: settings.customThankYouMessage
    });
    
    // Notify the requester
    await slackService.notifyRequesterOfCompletion({
      client,
      requesterId: review.requesterId,
      reviewerName: review.reviewerName,
      prUrl: review.prUrl
    });
    
    await respond({
      text: 'Review marked as completed. Thank you for your review!',
      response_type: 'ephemeral'
    });
  } catch (error) {
    console.error('Error completing review:', error);
    await respond({
      text: 'An error occurred while completing the review. Please try again.',
      response_type: 'ephemeral'
    });
  }
}

/**
 * Handle /review cancel PR_URL
 */
async function handleCancelReview({ args, userId, teamId, respond, client }) {
  if (args.length < 2) {
    return await respond({
      text: 'Missing PR URL. Usage: `/review cancel PR_URL`',
      response_type: 'ephemeral'
    });
  }
  
  const prUrl = args[1];
  
  try {
    // Find the review
    const review = await Review.findOne({ 
      prUrl, 
      requesterId: userId,
      status: 'pending'
    });
    
    if (!review) {
      return await respond({
        text: 'No pending review found for this PR URL or you are not the requester.',
        response_type: 'ephemeral'
      });
    }
    
    // Mark as cancelled
    await review.markAsCancelled();
    
    // Update the message in the channel
    if (review.channelId && review.messageTs) {
      await slackService.updateReviewMessage({
        client,
        channelId: review.channelId,
        messageTs: review.messageTs,
        status: 'cancelled',
        reviewId: review._id,
        requesterName: review.requesterName,
        reviewerName: review.reviewerName,
        prUrl: review.prUrl
      });
    }
    
    // Notify the reviewer
    await slackService.notifyReviewerOfCancellation({
      client,
      reviewerId: review.reviewerId,
      requesterName: review.requesterName,
      prUrl: review.prUrl
    });
    
    await respond({
      text: 'Review request cancelled.',
      response_type: 'ephemeral'
    });
  } catch (error) {
    console.error('Error cancelling review:', error);
    await respond({
      text: 'An error occurred while cancelling the review. Please try again.',
      response_type: 'ephemeral'
    });
  }
}

/**
 * Handle /review remind @user
 */
async function handleManualReminder({ args, userId, teamId, respond, client }) {
  if (args.length < 2) {
    return await respond({
      text: 'Missing user. Usage: `/review remind @user`',
      response_type: 'ephemeral'
    });
  }
  
  // Get the full text after the command to preserve the exact mention format
  const fullText = args.slice(1).join(' ');
  console.log(`Processing remind command with text: ${fullText}`);
  
  // First, get the mention from args
  const reviewerMention = args[1];
  let reviewerId = parseUserId(reviewerMention);
  
  // If the result starts with LOOKUP:, we need to convert username to ID
  if (reviewerId && reviewerId.startsWith('LOOKUP:')) {
    const username = reviewerId.substring(7); // Remove "LOOKUP:" prefix
    console.log(`Looking up user ID for username: ${username}`);
    reviewerId = await usernameToId(username, client);
  }
  
  if (!reviewerId) {
    return await respond({
      text: 'Invalid user mention. Please use @username to mention the reviewer.',
      response_type: 'ephemeral'
    });
  }
  
  try {
    // Find reviews requested by the user for the specified reviewer
    const reviews = await Review.find({
      requesterId: userId,
      reviewerId: reviewerId,
      status: 'pending'
    }).sort({ requestedAt: 1 });
    
    if (reviews.length === 0) {
      return await respond({
        text: 'No pending reviews found for this user.',
        response_type: 'ephemeral'
      });
    }
    
    // Send reminders
    const settings = await Settings.getForTeam(teamId);
    const userInfo = await client.users.info({ user: userId });
    const requesterName = userInfo.user.real_name || userInfo.user.name;
    
    for (const review of reviews) {
      await slackService.sendReminderMessage({
        client,
        reviewerId: review.reviewerId,
        requesterName,
        prUrl: review.prUrl,
        message: settings.reminderMessage,
        isManual: true
      });
      
      // Update reminder information
      await review.updateReminder();
    }
    
    await respond({
      text: `Reminder sent to ${reviewerMention} for ${reviews.length} pending review(s).`,
      response_type: 'ephemeral'
    });
  } catch (error) {
    console.error('Error sending manual reminder:', error);
    await respond({
      text: 'An error occurred while sending the reminder. Please try again.',
      response_type: 'ephemeral'
    });
  }
}

/**
 * Handle /review settings [set key value]
 */
async function handleSettings({ args, userId, teamId, respond, client }) {
  try {
    // Check user permissions (only admins should be able to change settings)
    const userInfo = await client.users.info({ user: userId });
    const isAdmin = userInfo.user.is_admin;
    
    // If not admin and trying to set settings, reject
    if (args.length > 1 && args[1] === 'set' && !isAdmin) {
      return await respond({
        text: 'Only workspace admins can change settings.',
        response_type: 'ephemeral'
      });
    }
    
    // Get current settings
    const settings = await Settings.getForTeam(teamId);
    
    // If user wants to update settings
    if (args.length > 3 && args[1] === 'set') {
      const key = args[2];
      const value = args[3];
      
      // Update the setting based on the key
      switch (key) {
        case 'frequency':
          const hours = parseInt(value, 10);
          if (isNaN(hours) || hours < 1 || hours > 168) {
            return await respond({
              text: 'Invalid frequency. Please provide a number between 1 and 168 hours.',
              response_type: 'ephemeral'
            });
          }
          settings.reminderFrequencyHours = hours;
          break;
        case 'message':
          settings.reminderMessage = args.slice(3).join(' ');
          break;
        case 'enabled':
          if (value !== 'true' && value !== 'false') {
            return await respond({
              text: 'Invalid value for enabled. Use "true" or "false".',
              response_type: 'ephemeral'
            });
          }
          settings.reminderEnabled = value === 'true';
          break;
        case 'limit':
          const limit = parseInt(value, 10);
          if (isNaN(limit) || limit < 1 || limit > 10) {
            return await respond({
              text: 'Invalid limit. Please provide a number between 1 and 10.',
              response_type: 'ephemeral'
            });
          }
          settings.reminderLimit = limit;
          break;
        case 'thankyou':
          settings.customThankYouMessage = args.slice(3).join(' ');
          break;
        default:
          return await respond({
            text: 'Invalid setting key. Available keys: frequency, message, enabled, limit, thankyou',
            response_type: 'ephemeral'
          });
      }
      
      await settings.save();
      
      return await respond({
        text: `Setting "${key}" updated successfully.`,
        response_type: 'ephemeral'
      });
    }
    
    // Display current settings
    let responseText = '*Current Settings*\n\n';
    responseText += `*Reminder Frequency*: ${settings.reminderFrequencyHours} hours\n`;
    responseText += `*Reminders Enabled*: ${settings.reminderEnabled ? 'Yes' : 'No'}\n`;
    responseText += `*Max Reminders*: ${settings.reminderLimit}\n`;
    responseText += `*Reminder Message*: ${settings.reminderMessage}\n`;
    responseText += `*Thank You Message*: ${settings.customThankYouMessage}\n\n`;
    
    if (isAdmin) {
      responseText += '*To update settings, use:*\n';
      responseText += '`/review settings set frequency 24` - Set reminder frequency in hours\n';
      responseText += '`/review settings set message Your reminder message` - Set the reminder message\n';
      responseText += '`/review settings set enabled true|false` - Enable or disable reminders\n';
      responseText += '`/review settings set limit 3` - Set maximum number of reminders\n';
      responseText += '`/review settings set thankyou Your thank you message` - Set thank you message';
    }
    
    await respond({
      text: responseText,
      response_type: 'ephemeral'
    });
  } catch (error) {
    console.error('Error handling settings:', error);
    await respond({
      text: 'An error occurred while managing settings. Please try again.',
      response_type: 'ephemeral'
    });
  }
}

/**
 * Show help message
 */
async function showHelp(respond) {
  const helpText = `
*Code Review Bot Help*

*/review request @user PR_URL*
Request a code review from a user

*/review list*
List all your pending reviews (requested by you or waiting for your review)

*/review complete PR_URL*
Mark a review as completed (use this when you've finished reviewing)

*/review cancel PR_URL*
Cancel a review request (only the requester can do this)

*/review remind @user*
Send a manual reminder to a user for pending reviews

*/review settings*
View and manage reminder settings

*/review help*
Show this help message
  `;
  
  await respond({
    text: helpText,
    response_type: 'ephemeral'
  });
}

module.exports = {
  handleReviewCommand
}; 
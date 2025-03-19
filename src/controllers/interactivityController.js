const Review = require('../models/Review');
const Settings = require('../models/Settings');
const slackService = require('../services/slackService');
const ContributionReport = require('../models/ContributionReport');

/**
 * Handle interactivity from Slack messages (buttons, etc.)
 */
async function handleInteractivity({ body, ack, client, respond }) {
  try {
    // Acknowledge the request immediately
    await ack();
    
    // Handle button actions
    if (body.actions && body.actions.length > 0) {
      const action = body.actions[0];
      
      // Handle complete_review button
      if (action.action_id === 'complete_review' && action.value) {
        await handleCompleteReviewButton({
          value: action.value, 
          user: body.user, 
          channel: body.channel,
          client
        });
      }
    }

    // Extract the action value and ID
    const { value, action_id } = body.actions[0];
    
    if (action_id === 'view_details') {
      await handleViewDetails({ value, body, client, respond });
    }
  } catch (error) {
    console.error('Error handling interactivity:', error);
    await respond({
      text: 'An error occurred while processing your action. Please try again.',
      replace_original: false
    });
  }
}

/**
 * Handle the "Mark as Completed" button click
 */
async function handleCompleteReviewButton({ value, user, channel, client }) {
  try {
    // Extract the review ID from the button value
    const reviewId = value.replace('complete_', '');
    
    // Find the review
    const review = await Review.findById(reviewId);
    
    if (!review) {
      // Review not found
      await client.chat.postEphemeral({
        channel: channel.id,
        user: user.id,
        text: 'This review could not be found. It may have been deleted or already completed.'
      });
      return;
    }
    
    // Check if the clicker is the reviewer
    if (review.reviewerId !== user.id) {
      // Not the reviewer
      await client.chat.postEphemeral({
        channel: channel.id,
        user: user.id,
        text: 'Only the assigned reviewer can mark this review as completed.'
      });
      return;
    }
    
    // Check if review is already completed or cancelled
    if (review.status !== 'pending') {
      await client.chat.postEphemeral({
        channel: channel.id,
        user: user.id,
        text: `This review is already marked as ${review.status}.`
      });
      return;
    }
    
    // Mark as completed
    await review.markAsCompleted();
    
    // Update the message in the channel
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
    
    // Get team settings
    const channelInfo = await client.conversations.info({ channel: channel.id });
    const teamId = channelInfo.channel.shared_team_id || channelInfo.channel.context_team_id;
    const settings = await Settings.getForTeam(teamId);
    
    // Send thank you message to the reviewer
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
    
    // Send confirmation
    await client.chat.postEphemeral({
      channel: channel.id,
      user: user.id,
      text: 'Review marked as completed. Thank you!'
    });
  } catch (error) {
    console.error('Error handling complete review button:', error);
    
    // Send error message
    await client.chat.postEphemeral({
      channel: channel.id,
      user: user.id,
      text: 'An error occurred while completing the review. Please try again or use the `/review complete` command.'
    });
  }
}

/**
 * Handle the "View Details" button actions
 */
async function handleViewDetails({ value, body, client, respond }) {
  // Value format: type_data_reportId, e.g. "user_username_60f1a2b3c4d5e6f7g8h9i0"
  const [type, data, reportId] = value.split('_');
  
  try {
    // Get the report from the database
    const report = await ContributionReport.findById(reportId);
    
    if (!report) {
      return await respond({
        text: 'Report not found. It may have been deleted or expired.',
        replace_original: false
      });
    }
    
    // Handle different types of details views
    switch (type) {
      case 'user':
        await showUserDetails({ data: data, report: report.data, respond });
        break;
      case 'all':
        await showAllUsers({ report: report.data, respond });
        break;
      case 'repos':
        await showRepoDetails({ report: report.data, respond });
        break;
      default:
        await respond({
          text: 'Unknown detail type requested.',
          replace_original: false
        });
    }
  } catch (error) {
    console.error('Error showing details:', error);
    await respond({
      text: 'An error occurred while retrieving details. Please try again.',
      replace_original: false
    });
  }
}

/**
 * Show detailed report for a specific user
 */
async function showUserDetails({ data: username, report, respond }) {
  if (!report.users[username]) {
    return await respond({
      text: `No data found for user ${username}.`,
      replace_original: false
    });
  }
  
  const userData = report.users[username];
  const { startDate, endDate } = report.summary.period;
  const formattedStartDate = new Date(startDate).toLocaleDateString();
  const formattedEndDate = new Date(endDate).toLocaleDateString();
  
  let text = `*GitHub Contributions for ${username}*\n`;
  text += `*Period:* ${formattedStartDate} to ${formattedEndDate}\n\n`;
  
  text += `*Summary:*\n`;
  text += `• Total Commits: ${userData.totalCommits}\n`;
  text += `• Total Pull Requests: ${userData.totalPRs}\n`;
  text += `• Total Issues: ${userData.totalIssues}\n`;
  text += `• Activity Score: ${userData.activityScore}\n\n`;
  
  text += `*Contributions by Repository:*\n`;
  for (const [repo, stats] of Object.entries(userData.repositories)) {
    if (stats.commits > 0 || stats.pullRequests > 0 || stats.issues > 0) {
      text += `• *${repo}*\n`;
      text += `  Commits: ${stats.commits} | PRs: ${stats.pullRequests} | Issues: ${stats.issues}\n`;
    }
  }
  
  await respond({
    text,
    replace_original: false
  });
}

/**
 * Show all users in a report
 */
async function showAllUsers({ report, respond }) {
  const { startDate, endDate } = report.summary.period;
  const formattedStartDate = new Date(startDate).toLocaleDateString();
  const formattedEndDate = new Date(endDate).toLocaleDateString();
  
  // Rank users by activity score
  const rankedUsers = Object.entries(report.users)
    .map(([username, data]) => ({ username, ...data }))
    .sort((a, b) => b.activityScore - a.activityScore);
  
  let text = `*All Contributors*\n`;
  text += `*Period:* ${formattedStartDate} to ${formattedEndDate}\n\n`;
  
  rankedUsers.forEach((user, index) => {
    text += `${index + 1}. *${user.username}* - Activity Score: ${user.activityScore}\n`;
    text += `   Commits: ${user.totalCommits} | PRs: ${user.totalPRs} | Issues: ${user.totalIssues}\n`;
  });
  
  if (rankedUsers.length === 0) {
    text += "No contributors found in this period.";
  }
  
  await respond({
    text,
    replace_original: false
  });
}

/**
 * Show repository details
 */
async function showRepoDetails({ report, respond }) {
  const { startDate, endDate } = report.summary.period;
  const formattedStartDate = new Date(startDate).toLocaleDateString();
  const formattedEndDate = new Date(endDate).toLocaleDateString();
  
  let text = `*Repository Activity*\n`;
  text += `*Period:* ${formattedStartDate} to ${formattedEndDate}\n\n`;
  
  for (const [repoName, repoData] of Object.entries(report.repositories)) {
    text += `*${repoName}*\n`;
    text += `• Commits: ${repoData.commits}\n`;
    text += `• Pull Requests: ${repoData.pullRequests}\n`;
    text += `• Issues: ${repoData.issues}\n`;
    
    if (repoData.contributors.length > 0) {
      text += `• Contributors: ${repoData.contributors.join(', ')}\n`;
    } else {
      text += `• Contributors: None\n`;
    }
    
    text += '\n';
  }
  
  await respond({
    text,
    replace_original: false
  });
}

module.exports = {
  handleInteractivity
}; 
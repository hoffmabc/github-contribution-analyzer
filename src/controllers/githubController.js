const { Octokit } = require('@octokit/rest');
const ContributionReport = require('../models/ContributionReport');
const { formatTimestamp } = require('../utils/slackHelpers');
const axios = require('axios');

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
    console.log('WARNING: GitHub token contains newline characters - sanitizing...');
    sanitized = sanitized.replace(/[\n\r]/g, '');
  }
  
  // Check for and remove any null bytes or other control characters
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');
  
  if (sanitized.length === 0) {
    console.log('WARNING: GitHub token is empty after sanitization');
    return undefined;
  }
  
  // Verify the token doesn't contain problematic characters for HTTP headers
  const invalidHeaderChars = /[^\t\x20-\x7E\x80-\xFF]/;
  if (invalidHeaderChars.test(sanitized)) {
    console.log('WARNING: GitHub token contains invalid characters for HTTP headers - sanitizing...');
    sanitized = sanitized.replace(invalidHeaderChars, '');
  }
  
  return sanitized;
}

// Safely get GitHub token
const githubToken = sanitizeToken(process.env.GITHUB_TOKEN);

// Validate token
if (!githubToken) {
  console.error('GitHub token is missing or invalid. GitHub API calls will fail.');
}

// Initialize Octokit with GitHub token
let octokit;
try {
  // Check if token is valid before creating the client
  if (githubToken && githubToken.length > 0) {
    console.log(`Initializing GitHub client with token of length: ${githubToken.length}`);
    
    // Only use alphanumeric and certain special characters that are common in tokens
    // GitHub tokens are typically 40 characters of hex for classic tokens
    // or longer for the newer fine-grained tokens, but still alphanumeric
    const cleanToken = githubToken.replace(/[^a-zA-Z0-9_\-]/g, '');
    
    if (cleanToken.length < githubToken.length) {
      console.warn(`GitHub token had ${githubToken.length - cleanToken.length} invalid characters removed`);
    }
    
    // Only create authenticated client if we have a clean token
    if (cleanToken.length > 0) {
      octokit = new Octokit({
        auth: cleanToken
      });
      console.log('GitHub Octokit client initialized successfully with authentication');
    } else {
      throw new Error('GitHub token was sanitized to empty string');
    }
  } else {
    throw new Error('No GitHub token available');
  }
} catch (error) {
  console.error('Failed to initialize authenticated GitHub Octokit client:', error.message);
  console.log('Creating unauthenticated GitHub client as fallback');
  // Create a fallback client with no authentication - will have rate limiting
  octokit = new Octokit();
}

// Parse repositories from environment variable or use defaults
function parseRepositories() {
  try {
    // Check if GITHUB_REPOS is defined in the environment
    const reposEnv = process.env.GITHUB_REPOS;
    
    if (reposEnv) {
      console.log('Using repositories from environment variable');
      
      // Parse the JSON array from the environment variable
      try {
        const repos = JSON.parse(reposEnv);
        
        // Validate the format of each repository
        if (Array.isArray(repos) && repos.every(repo => repo.owner && repo.repo)) {
          return repos;
        } else {
          console.error('Invalid repository format in GITHUB_REPOS environment variable');
          console.error('Expected format: [{"owner":"owner1","repo":"repo1"},{"owner":"owner2","repo":"repo2"}]');
          // Fall back to defaults
        }
      } catch (parseError) {
        console.error('Failed to parse GITHUB_REPOS environment variable:', parseError.message);
        // Fall back to defaults
      }
    }
    
    // Default repositories if not configured or invalid format
    return [
      { owner: 'arch-network', repo: 'arch-network' },
      { owner: 'arch-network', repo: 'book' },
      { owner: 'arch-network', repo: 'arch-infrastructure' },
      { owner: 'arch-network', repo: 'arch-k8s' }
    ];
  } catch (error) {
    console.error('Error parsing repositories:', error);
    // Return default repositories in case of any error
    return [
      { owner: 'arch-network', repo: 'arch-network' },
      { owner: 'arch-network', repo: 'book' },
      { owner: 'arch-network', repo: 'arch-infrastructure' },
      { owner: 'arch-network', repo: 'arch-k8s' }
    ];
  }
}

// List of repos to analyze
const REPOS = parseRepositories();

/**
 * Handle the /review Slack command
 */
async function handleReviewCommand({ command, respond, client }) {
  try {
    const { text, user_id, team_id, channel_id } = command;
    const args = text.trim().split(' ');
    const subCommand = args[0]?.toLowerCase() || 'help';
    
    // Route to the appropriate sub-command handler
    switch (subCommand) {
      case 'generate':
        await handleGenerateReport({ args, userId: user_id, teamId: team_id, channelId: channel_id, respond, client });
        break;
      case 'user':
        await handleUserReport({ args, userId: user_id, teamId: team_id, respond, client });
        break;
      case 'lastweek':
        await handleLastWeekReport({ args, userId: user_id, teamId: team_id, channelId: channel_id, respond, client });
        break;
      case 'token':
        await handleTokenInfo({ respond });
        break;
      case 'help':
      default:
        await showHelp(respond);
        break;
    }
  } catch (error) {
    console.error('Error handling GitHub review command:', error);
    await respond({
      text: 'An error occurred while processing your command. Please try again.',
      response_type: 'ephemeral'
    });
  }
}

/**
 * Generate a contributions report for all users
 */
async function handleGenerateReport({ args, userId, teamId, channelId, respond, client }) {
  try {
    // Immediately acknowledge the command to prevent timeout
    await respond({
      text: 'Starting GitHub contribution report generation...\n\nThis process can take a while to complete. You will not see a "failed with operation_timeout" message, and the report will be posted to the channel when ready.',
      response_type: 'ephemeral'
    });
    
    // Run the report generation in the background (no await)
    generateAndPostReport(client, channelId, respond)
      .catch(error => {
        console.error('Error in background report generation:', error);
      });
    
    // Function exits immediately after acknowledgment
  } catch (error) {
    console.error('Error acknowledging report generation command:', error);
    // Try to respond but don't await (best effort)
    respond({
      text: 'An error occurred while starting the GitHub contribution report. Please try again.',
      response_type: 'ephemeral'
    }).catch(err => console.error('Failed to send error response:', err));
  }
}

/**
 * Helper function to generate and post report in the background
 */
async function generateAndPostReport(client, channelId, respond) {
  try {
    // Generate the report
    const report = await generateContributionReport();
    
    // Save the report to the database
    const savedReport = await saveReport(report);
    
    // Post the report summary to the channel
    await postReportToChannel(client, channelId, report, savedReport._id);
    
    // Send a follow-up ephemeral message (optional, may fail if too much time has passed)
    try {
      await respond({
        text: 'Report has been generated and posted to the channel.',
        response_type: 'ephemeral'
      });
    } catch (respondError) {
      console.log('Could not send follow-up message (expected if too much time passed):', respondError.message);
    }
  } catch (error) {
    console.error('Error generating report in background process:', error);
    // Try to notify about error, but it might fail if too much time has passed
    try {
      await client.chat.postMessage({
        channel: channelId,
        text: 'An error occurred while generating the GitHub contribution report. Please try again.'
      });
    } catch (notifyError) {
      console.error('Failed to notify about report generation error:', notifyError);
    }
  }
}

/**
 * Generate a report for a specific user
 */
async function handleUserReport({ args, userId, teamId, respond, client }) {
  if (args.length < 2) {
    return await respond({
      text: 'Missing username. Usage: `/review user username`',
      response_type: 'ephemeral'
    });
  }
  
  const username = args[1];
  
  try {
    // Immediately acknowledge the command to prevent timeout
    await respond({
      text: `Starting GitHub contribution report generation for ${username}...\n\nThis process might take a moment. The report will be sent when complete.`,
      response_type: 'ephemeral'
    });
    
    // Run the user report generation in the background
    generateAndSendUserReport(username, respond, client, userId)
      .catch(error => {
        console.error(`Error in background user report generation for ${username}:`, error);
      });
    
    // Function exits immediately after acknowledgment
  } catch (error) {
    console.error(`Error acknowledging user report command for ${username}:`, error);
    // Try to respond but don't await (best effort)
    respond({
      text: `An error occurred while starting the GitHub contribution report for ${username}. Please try again.`,
      response_type: 'ephemeral'
    }).catch(err => console.error('Failed to send error response:', err));
  }
}

/**
 * Helper function to generate and send user report in the background
 */
async function generateAndSendUserReport(username, respond, client, userId) {
  try {
    // Generate the report for a specific user
    const report = await generateUserContributionReport(username);
    
    // Format the user report
    const formattedReport = formatUserReport(report);
    
    // Send the report as a direct message instead of ephemeral response
    // This ensures the user gets the report even if the original response times out
    try {
      await client.chat.postMessage({
        channel: userId,
        text: `Here's your requested report for user ${username}:`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: formattedReport
            }
          }
        ]
      });
    } catch (dmError) {
      console.error(`Failed to send DM with user report for ${username}:`, dmError);
      // Fall back to trying the original respond method
      await respond({
        text: formattedReport,
        response_type: 'ephemeral'
      });
    }
  } catch (error) {
    console.error(`Error generating user report for ${username} in background:`, error);
    // Try to notify about error through DM
    try {
      await client.chat.postMessage({
        channel: userId,
        text: `An error occurred while generating the GitHub contribution report for ${username}. Please try again.`
      });
    } catch (notifyError) {
      console.error(`Failed to notify about user report error for ${username}:`, notifyError);
    }
  }
}

/**
 * Show previous week's report
 */
async function handleLastWeekReport({ args, userId, teamId, channelId, respond, client }) {
  try {
    // Immediately acknowledge the command to prevent timeout
    await respond({
      text: 'Retrieving previous report... The report will be posted to the channel shortly.',
      response_type: 'ephemeral'
    });
    
    // Run the last week report retrieval in the background
    retrieveAndPostLastReport(client, channelId, respond)
      .catch(error => {
        console.error('Error in background last week report retrieval:', error);
      });
    
    // Function exits immediately after acknowledgment
  } catch (error) {
    console.error('Error acknowledging last week report command:', error);
    // Try to respond but don't await (best effort)
    respond({
      text: 'An error occurred while starting to retrieve the previous report. Please try again.',
      response_type: 'ephemeral'
    }).catch(err => console.error('Failed to send error response:', err));
  }
}

/**
 * Helper function to retrieve and post last week's report in the background
 */
async function retrieveAndPostLastReport(client, channelId, respond) {
  try {
    // Find the most recent report
    const lastReport = await ContributionReport.findOne().sort({ createdAt: -1 });
    
    if (!lastReport) {
      // No previous reports found
      try {
        await client.chat.postMessage({
          channel: channelId,
          text: 'No previous reports found. Please generate a new report using `/review generate`.'
        });
      } catch (notifyError) {
        console.error('Failed to notify about missing reports:', notifyError);
      }
      return;
    }
    
    // Post the report to the channel
    await postReportToChannel(client, channelId, lastReport.data, lastReport._id);
    
    // Try to send a follow-up message (may fail if too much time passed)
    try {
      await respond({
        text: `Previous report from ${formatTimestamp(lastReport.createdAt)} has been posted to the channel.`,
        response_type: 'ephemeral'
      });
    } catch (respondError) {
      console.log('Could not send follow-up message (expected if too much time passed):', respondError.message);
    }
  } catch (error) {
    console.error('Error retrieving last week report in background:', error);
    // Try to notify about error
    try {
      await client.chat.postMessage({
        channel: channelId,
        text: 'An error occurred while retrieving the previous report. Please try again.'
      });
    } catch (notifyError) {
      console.error('Failed to notify about report retrieval error:', notifyError);
    }
  }
}

/**
 * Generate AI analysis of contributions using Claude
 */
async function generateAIAnalysis(contributionData) {
  try {
    console.log('Generating AI analysis of contributions...');
    
    // Prepare the data in a format suitable for Claude
    const contributors = Object.entries(contributionData.users)
      .map(([username, data]) => ({
        username,
        activityScore: data.activityScore,
        totalCommits: data.totalCommits,
        totalPRs: data.totalPRs,
        totalIssues: data.totalIssues,
        repositories: Object.entries(data.repositories)
          .filter(([_, stats]) => stats.commits > 0 || stats.pullRequests > 0 || stats.issues > 0)
          .map(([repo, stats]) => ({
            repo,
            commits: stats.commits,
            pullRequests: stats.pullRequests,
            issues: stats.issues
          }))
      }))
      .sort((a, b) => b.activityScore - a.activityScore)
      .slice(0, 5); // Analyze top 5 contributors to keep it reasonable
    
    // No contributors to analyze
    if (contributors.length === 0) {
      return {
        summary: "No significant contributions found in the analyzed repositories during this period.",
        contributors: {}
      };
    }
    
    // Anthropic Claude API endpoint (substitute with your preferred AI service)
    // For a real implementation, you would use an environment variable for the API key
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    
    if (!ANTHROPIC_API_KEY) {
      console.log('No Anthropic API key found, skipping AI analysis');
      return null;
    }
    
    // Create prompt for Claude
    const prompt = `
As a GitHub contribution analyst, please review the following contributor data and provide:
1. A brief overall summary of team activity (2-3 sentences)
2. For each contributor, provide:
   - Brief assessment of their contribution pattern
   - Strengths and potential areas for improvement
   - Specific insights based on their commit/PR/issue distribution

Contribution data for the past week:
${JSON.stringify(contributors, null, 2)}

IMPORTANT: Keep each contributor's analysis concise (3-4 sentences maximum).
Focus on patterns like:
- Ratio between different contribution types (commits/PRs/issues)
- Concentration in specific repositories
- Activity score relative to others

Respond in this JSON format:
{
  "summary": "Overall team activity summary",
  "contributors": {
    "username1": {
      "assessment": "Concise assessment",
      "strengths": ["Strength 1", "Strength 2"],
      "areasForImprovement": ["Area 1", "Area 2"]
    },
    ...
  }
}`;

    try {
      // Call Claude API
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: "claude-3-sonnet-20240229",
          max_tokens: 1024,
          messages: [
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.7
        },
        {
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          }
        }
      );
      
      // Parse the response to get the analysis
      const content = response.data.content[0].text;
      
      // Extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const analysisJson = JSON.parse(jsonMatch[0]);
        console.log('AI analysis generated successfully');
        return analysisJson;
      } else {
        console.error('Could not extract JSON from AI response:', content);
        return null;
      }
    } catch (error) {
      console.error('Error calling Claude API:', error.message);
      return null;
    }
  } catch (error) {
    console.error('Error generating AI analysis:', error);
    return null;
  }
}

/**
 * Fetch detailed content for commits, PRs, and issues
 */
async function fetchDetailedContent(owner, repo, contributions) {
  try {
    console.log(`Fetching detailed content for ${owner}/${repo}...`);
    
    // For each user's commits, fetch the actual code changes
    for (const username in contributions.users) {
      const user = contributions.users[username];
      
      if (!user.codeContent) {
        user.codeContent = {
          commitDetails: [],
          prDetails: [],
          issueDetails: []
        };
      }
      
      // Fetch detailed commit information (with diffs)
      for (const repoKey in user.repositories) {
        if (!repoKey.startsWith(`${owner}/${repo}`)) continue;
        
        const repoStats = user.repositories[repoKey];
        if (repoStats.commits > 0) {
          // Get this user's commits for this repo
          try {
            const commits = await fetchCommitsForRepo({ owner, name: repo }, new Date(contributions.summary.period.startDate), new Date(contributions.summary.period.endDate));
            
            // For each commit, get the detailed changes (diffs)
            for (const commit of commits.slice(0, 5)) { // Limit to 5 commits for performance
              try {
                const commitData = await octokit.repos.getCommit({
                  owner,
                  repo,
                  ref: commit.sha
                });
                
                // Extract relevant information
                const files = commitData.data.files || [];
                const fileChanges = files.map(file => ({
                  filename: file.filename,
                  status: file.status,
                  additions: file.additions,
                  deletions: file.deletions,
                  changes: file.changes,
                  patch: file.patch && file.patch.length > 500 
                    ? file.patch.substring(0, 500) + '...' // Truncate large diffs
                    : file.patch
                }));
                
                user.codeContent.commitDetails.push({
                  sha: commit.sha,
                  message: commit.commit.message,
                  date: commit.commit.author.date,
                  fileChanges: fileChanges
                });
              } catch (error) {
                console.error(`Error fetching commit details for ${commit.sha}:`, error.message);
              }
            }
          } catch (error) {
            console.error(`Error fetching commits by author ${username}:`, error.message);
          }
        }
        
        // Fetch PR details
        if (repoStats.pullRequests > 0) {
          try {
            const userPRs = await getPullRequestsByUser(owner, repo, username);
            
            for (const pr of userPRs.slice(0, 3)) { // Limit to 3 PRs for performance
              try {
                // Get PR details including the files changed
                const prFiles = await octokit.pulls.listFiles({
                  owner,
                  repo,
                  pull_number: pr.number
                });
                
                // Get PR reviews
                const reviews = await octokit.pulls.listReviews({
                  owner,
                  repo,
                  pull_number: pr.number
                });
                
                // Extract relevant information
                const fileChanges = prFiles.data.map(file => ({
                  filename: file.filename,
                  status: file.status,
                  additions: file.additions,
                  deletions: file.deletions,
                  changes: file.changes
                }));
                
                const reviewSummary = reviews.data.map(review => ({
                  reviewer: review.user.login,
                  state: review.state,
                  body: review.body && review.body.length > 200 
                    ? review.body.substring(0, 200) + '...' 
                    : review.body
                }));
                
                user.codeContent.prDetails.push({
                  number: pr.number,
                  title: pr.title,
                  state: pr.state,
                  created_at: pr.created_at,
                  fileCount: fileChanges.length,
                  totalChanges: fileChanges.reduce((sum, file) => sum + file.changes, 0),
                  fileChanges: fileChanges.slice(0, 5), // Limit to first 5 files
                  reviews: reviewSummary
                });
              } catch (error) {
                console.error(`Error fetching PR details for #${pr.number}:`, error.message);
              }
            }
          } catch (error) {
            console.error(`Error fetching PRs by user ${username}:`, error.message);
          }
        }
        
        // Fetch issue details
        if (repoStats.issues > 0) {
          try {
            const userIssues = await getIssuesByUser(owner, repo, username);
            
            for (const issue of userIssues.slice(0, 3)) { // Limit to 3 issues for performance
              if (issue.pull_request) continue; // Skip PRs that are also counted as issues
              
              try {
                // Get issue comments
                const comments = await octokit.issues.listComments({
                  owner,
                  repo,
                  issue_number: issue.number
                });
                
                const commentSummary = comments.data.map(comment => ({
                  user: comment.user.login,
                  body: comment.body && comment.body.length > 200 
                    ? comment.body.substring(0, 200) + '...' 
                    : comment.body
                }));
                
                user.codeContent.issueDetails.push({
                  number: issue.number,
                  title: issue.title,
                  state: issue.state,
                  created_at: issue.created_at,
                  body: issue.body && issue.body.length > 300 
                    ? issue.body.substring(0, 300) + '...' 
                    : issue.body,
                  comments: commentSummary
                });
              } catch (error) {
                console.error(`Error fetching issue details for #${issue.number}:`, error.message);
              }
            }
          } catch (error) {
            console.error(`Error fetching issues by user ${username}:`, error.message);
          }
        }
      }
    }
    
    return true;
  } catch (error) {
    console.error(`Error in fetchDetailedContent for ${owner}/${repo}:`, error);
    return false;
  }
}

// Improved function to fetch commits with retry logic
async function fetchCommitsForRepo(repo, since, until) {
  try {
    let allCommits = [];
    let page = 1;
    let hasMoreCommits = true;
    const maxRetries = 3;
    
    console.log(`Fetching commits for ${repo.owner}/${repo.name} from ${since.toISOString()} to ${until.toISOString()}`);

    while (hasMoreCommits) {
      let retries = 0;
      let success = false;
      
      while (!success && retries < maxRetries) {
        try {
          console.log(`Fetching page ${page} of commits for ${repo.owner}/${repo.name}`);
          
          const response = await octokit.rest.repos.listCommits({
            owner: repo.owner,
            repo: repo.name,
            since: since.toISOString(),
            until: until.toISOString(),
            per_page: 100,
            page: page,
          });

          console.log(`Received ${response.data.length} commits for ${repo.owner}/${repo.name} (page ${page})`);
          
          if (response.data.length === 0) {
            hasMoreCommits = false;
          } else {
            allCommits = [...allCommits, ...response.data];
            page++;
          }
          success = true;
        } catch (error) {
          retries++;
          console.log(`Error fetching commits for ${repo.owner}/${repo.name} (page ${page}, attempt ${retries}): ${error.message}`);
          
          if (error.status === 403 && error.response?.headers?.['x-ratelimit-remaining'] === '0') {
            // Handle rate limiting
            const resetTime = error.response.headers['x-ratelimit-reset'];
            const waitTime = Math.max(resetTime * 1000 - Date.now(), 0) + 1000; // Add 1 second buffer
            console.log(`Rate limited. Waiting for ${waitTime/1000} seconds before retrying...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          } else if (retries < maxRetries) {
            // Exponential backoff for other errors
            const waitTime = Math.pow(2, retries) * 1000;
            console.log(`Retrying in ${waitTime/1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          } else {
            console.error(`Failed to fetch commits for ${repo.owner}/${repo.name} (page ${page}) after ${maxRetries} attempts`);
            // If we've already got some commits, continue with what we have
            if (allCommits.length > 0) {
              hasMoreCommits = false;
            } else {
              throw error; // Re-throw if we haven't got any commits
            }
          }
        }
      }
    }

    console.log(`Total commits fetched for ${repo.owner}/${repo.name}: ${allCommits.length}`);
    return allCommits;
  } catch (error) {
    console.error(`Error fetching commits for ${repo.owner}/${repo.name}:`, error);
    return []; // Return empty array on error
  }
}

/**
 * Get commits by a specific author
 */
async function getCommitsByAuthor(owner, repo, author) {
  try {
    // We'll use the search API to find commits by this author
    const response = await octokit.search.commits({
      q: `repo:${owner}/${repo}+author:${author}`,
      sort: 'author-date',
      order: 'desc',
      per_page: 10 // Limit to recent commits
    });
    
    return response.data.items || [];
  } catch (error) {
    console.error(`Error in getCommitsByAuthor for ${owner}/${repo}/${author}:`, error);
    return [];
  }
}

/**
 * Get pull requests by a specific user
 */
async function getPullRequestsByUser(owner, repo, username) {
  try {
    // Search for PRs by this user
    const response = await octokit.search.issuesAndPullRequests({
      q: `repo:${owner}/${repo}+author:${username}+is:pr`,
      sort: 'created',
      order: 'desc',
      per_page: 10
    });
    
    return response.data.items || [];
  } catch (error) {
    console.error(`Error in getPullRequestsByUser for ${owner}/${repo}/${username}:`, error);
    return [];
  }
}

/**
 * Get issues by a specific user
 */
async function getIssuesByUser(owner, repo, username) {
  try {
    // Search for issues by this user
    const response = await octokit.search.issuesAndPullRequests({
      q: `repo:${owner}/${repo}+author:${username}+is:issue`,
      sort: 'created',
      order: 'desc',
      per_page: 10
    });
    
    return response.data.items || [];
  } catch (error) {
    console.error(`Error in getIssuesByUser for ${owner}/${repo}/${username}:`, error);
    return [];
  }
}

/**
 * Generate more detailed AI analysis with code content evaluation
 */
async function generateDetailedAIAnalysis(contributionData) {
  try {
    console.log('Generating detailed AI analysis with code content evaluation...');
    
    // Prepare the data in a format suitable for Claude
    const contributors = Object.entries(contributionData.users)
      .map(([username, data]) => {
        // Get the essential user stats
        const contributor = {
          username,
          activityScore: data.activityScore,
          totalCommits: data.totalCommits,
          totalPRs: data.totalPRs,
          totalIssues: data.totalIssues,
          repositories: Object.entries(data.repositories)
            .filter(([_, stats]) => stats.commits > 0 || stats.pullRequests > 0 || stats.issues > 0)
            .map(([repo, stats]) => ({
              repo,
              commits: stats.commits,
              pullRequests: stats.pullRequests,
              issues: stats.issues
            }))
        };
        
        // Add code content if available
        if (data.codeContent) {
          // Add a sample of commit details (limited to avoid token limits)
          if (data.codeContent.commitDetails && data.codeContent.commitDetails.length > 0) {
            contributor.commitSamples = data.codeContent.commitDetails
              .slice(0, 2) // Limit to first 2 commits
              .map(commit => ({
                message: commit.message,
                date: commit.date,
                files: commit.fileChanges
                  .slice(0, 2) // Limit to first 2 files
                  .map(file => ({
                    filename: file.filename,
                    changes: {
                      additions: file.additions,
                      deletions: file.deletions,
                      total: file.changes
                    },
                    // Only include a small sample of the patch
                    patch: file.patch && file.patch.length > 300 
                      ? file.patch.substring(0, 300) + '...' 
                      : file.patch
                  }))
              }));
          }
          
          // Add a sample of PR details
          if (data.codeContent.prDetails && data.codeContent.prDetails.length > 0) {
            contributor.prSamples = data.codeContent.prDetails
              .slice(0, 2) // Limit to first 2 PRs
              .map(pr => ({
                title: pr.title,
                state: pr.state,
                fileCount: pr.fileCount,
                totalChanges: pr.totalChanges,
                // Include a sample of file changes
                files: pr.fileChanges
                  .slice(0, 2) // Limit to first 2 files
                  .map(file => ({
                    filename: file.filename,
                    changes: {
                      additions: file.additions,
                      deletions: file.deletions,
                      total: file.changes
                    }
                  })),
                // Include review feedback
                reviews: pr.reviews
                  .slice(0, 2) // Limit to first 2 reviews
                  .map(review => ({
                    reviewer: review.reviewer,
                    state: review.state,
                    comment: review.body && review.body.length > 150 
                      ? review.body.substring(0, 150) + '...' 
                      : review.body
                  }))
              }));
          }
          
          // Add a sample of issue details
          if (data.codeContent.issueDetails && data.codeContent.issueDetails.length > 0) {
            contributor.issueSamples = data.codeContent.issueDetails
              .slice(0, 2) // Limit to first 2 issues
              .map(issue => ({
                title: issue.title,
                state: issue.state,
                description: issue.body && issue.body.length > 200 
                  ? issue.body.substring(0, 200) + '...' 
                  : issue.body,
                // Include a sample of comments
                comments: issue.comments
                  .slice(0, 2) // Limit to first 2 comments
                  .map(comment => ({
                    user: comment.user,
                    content: comment.body && comment.body.length > 150 
                      ? comment.body.substring(0, 150) + '...' 
                      : comment.body
                  }))
              }));
          }
        }
        
        return contributor;
      })
      .sort((a, b) => b.activityScore - a.activityScore)
      .slice(0, 5); // Analyze top 5 contributors to keep it reasonable
    
    // No contributors to analyze
    if (contributors.length === 0) {
      return {
        summary: "No significant contributions found in the analyzed repositories during this period.",
        contributors: {}
      };
    }
    
    // Anthropic Claude API endpoint
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    
    if (!ANTHROPIC_API_KEY) {
      console.log('No Anthropic API key found, skipping detailed AI analysis');
      return null;
    }
    
    // Create prompt for Claude with more specific code quality instructions
    const prompt = `
As a GitHub contribution analyst with software engineering expertise, please review the following contributor data and provide:

1. A brief overall summary of team activity (2-3 sentences)
2. For each contributor, provide:
   - Assessment of their contribution pattern
   - Code quality evaluation based on:
     * Commit message quality and descriptiveness
     * Complexity of code changes
     * Code organization and readability
     * Test coverage and robustness
   - Technical strengths and areas for improvement
   - Specific insights based on their code, PR, and issue content

Contribution data for the past week:
${JSON.stringify(contributors, null, 2)}

IMPORTANT: 
- Evaluate both quantity AND quality of contributions
- Examine actual code samples when available
- Look for patterns in PR reviews and comments
- Consider issue descriptions and level of detail
- Keep each contributor's analysis concise (3-5 sentences maximum)

Respond in this JSON format:
{
  "summary": "Overall team activity summary with code quality assessment",
  "contributors": {
    "username1": {
      "assessment": "Concise assessment of contribution pattern and code quality",
      "codeInsights": "Specific observations about their code style, quality, and patterns",
      "strengths": ["Technical strength 1", "Technical strength 2"],
      "areasForImprovement": ["Technical area 1", "Technical area 2"],
      "codeQualityScore": 8.5
    },
    ...
  }
}

For codeQualityScore, use a scale of 1-10 where:
1-3: Needs significant improvement
4-6: Average quality code
7-8: Good quality code with minor issues 
9-10: Excellent, well-structured, maintainable code`;

    try {
      // Call Claude API
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: "claude-3-sonnet-20240229",
          max_tokens: 1500,
          messages: [
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.7
        },
        {
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          }
        }
      );
      
      // Parse the response to get the analysis
      const content = response.data.content[0].text;
      
      // Extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const analysisJson = JSON.parse(jsonMatch[0]);
        console.log('Detailed AI code analysis generated successfully');
        return analysisJson;
      } else {
        console.error('Could not extract JSON from AI response:', content);
        return null;
      }
    } catch (error) {
      console.error('Error calling Claude API for detailed analysis:', error.message);
      return null;
    }
  } catch (error) {
    console.error('Error generating detailed AI analysis:', error);
    return null;
  }
}

/**
 * Generate a GitHub contribution report across all repos
 */
async function generateContributionReport() {
  // Get contributions from the last 7 days
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);
  
  // Format dates for GitHub API
  const since = startDate.toISOString();
  const until = endDate.toISOString();
  
  // Initialize contribution data
  const contributions = {
    summary: {
      totalCommits: 0,
      totalPRs: 0,
      totalIssues: 0,
      repositories: REPOS.map(r => `${r.owner}/${r.repo}`),
      period: {
        startDate: since,
        endDate: until
      }
    },
    users: {},
    repositories: {}
  };
  
  // Process each repository
  for (const { owner, repo } of REPOS) {
    const repoKey = `${owner}/${repo}`;
    contributions.repositories[repoKey] = {
      commits: 0,
      pullRequests: 0,
      issues: 0,
      contributors: []
    };
    
    // Get commit activity
    const commits = await fetchCommitsForRepo({ owner, name: repo }, new Date(since), new Date(until));
    contributions.summary.totalCommits += commits.length;
    contributions.repositories[repoKey].commits = commits.length;
    
    // Process commits by user
    for (const commit of commits) {
      const author = commit.author?.login || commit.commit?.author?.name || 'Unknown';
      if (!contributions.users[author]) {
        initializeUserStats(contributions.users, author);
      }
      
      contributions.users[author].totalCommits++;
      contributions.users[author].repositories[repoKey].commits++;
      
      // Add contributor to repo's list if not already there
      if (!contributions.repositories[repoKey].contributors.includes(author)) {
        contributions.repositories[repoKey].contributors.push(author);
      }
    }
    
    // Get pull requests
    const prs = await getPullRequests(owner, repo, since, until);
    contributions.summary.totalPRs += prs.length;
    contributions.repositories[repoKey].pullRequests = prs.length;
    
    // Process PRs by user
    for (const pr of prs) {
      const author = pr.user.login;
      if (!contributions.users[author]) {
        initializeUserStats(contributions.users, author);
      }
      
      contributions.users[author].totalPRs++;
      contributions.users[author].repositories[repoKey].pullRequests++;
      
      // Add contributor to repo's list if not already there
      if (!contributions.repositories[repoKey].contributors.includes(author)) {
        contributions.repositories[repoKey].contributors.push(author);
      }
    }
    
    // Get issues
    const issues = await getIssues(owner, repo, since, until);
    contributions.summary.totalIssues += issues.length;
    contributions.repositories[repoKey].issues = issues.length;
    
    // Process issues by user
    for (const issue of issues) {
      // Skip pull requests that are also counted as issues
      if (issue.pull_request) continue;
      
      const author = issue.user.login;
      if (!contributions.users[author]) {
        initializeUserStats(contributions.users, author);
      }
      
      contributions.users[author].totalIssues++;
      contributions.users[author].repositories[repoKey].issues++;
      
      // Add contributor to repo's list if not already there
      if (!contributions.repositories[repoKey].contributors.includes(author)) {
        contributions.repositories[repoKey].contributors.push(author);
      }
    }
    
    // Fetch detailed content for commits, PRs, and issues
    await fetchDetailedContent(owner, repo, contributions);
  }
  
  // Calculate activity scores for ranking
  for (const username in contributions.users) {
    const user = contributions.users[username];
    // Simple weighted score: commits are worth 3, PRs are worth 5, issues are worth 1
    user.activityScore = (user.totalCommits * 3) + (user.totalPRs * 5) + (user.totalIssues * 1);
  }
  
  // Generate detailed AI analysis if possible (with code content)
  const aiAnalysis = await generateDetailedAIAnalysis(contributions);
  if (aiAnalysis) {
    contributions.aiAnalysis = aiAnalysis;
  } else {
    // Fall back to basic analysis if detailed analysis fails
    const basicAnalysis = await generateAIAnalysis(contributions);
    if (basicAnalysis) {
      contributions.aiAnalysis = basicAnalysis;
    }
  }
  
  return contributions;
}

/**
 * Generate report for a specific user
 */
async function generateUserContributionReport(username) {
  const fullReport = await generateContributionReport();
  
  // Extract just the user's data
  if (!fullReport.users[username]) {
    throw new Error(`No contributions found for user ${username}`);
  }
  
  return {
    user: username,
    data: fullReport.users[username],
    period: fullReport.summary.period
  };
}

/**
 * Initialize user statistics object
 */
function initializeUserStats(usersObj, username) {
  usersObj[username] = {
    totalCommits: 0,
    totalPRs: 0,
    totalIssues: 0,
    activityScore: 0,
    repositories: {}
  };
  
  // Initialize repository stats for this user
  for (const { owner, repo } of REPOS) {
    const repoKey = `${owner}/${repo}`;
    usersObj[username].repositories[repoKey] = {
      commits: 0,
      pullRequests: 0,
      issues: 0
    };
  }
}

/**
 * Save a report to the database
 */
async function saveReport(report) {
  const contributionReport = new ContributionReport({
    data: report,
    generatedAt: new Date()
  });
  
  return await contributionReport.save();
}

/**
 * Format and post a report to a Slack channel
 */
async function postReportToChannel(client, channelId, report, reportId) {
  // Create a summary message
  const { startDate, endDate } = report.summary.period;
  const formattedStartDate = new Date(startDate).toLocaleDateString();
  const formattedEndDate = new Date(endDate).toLocaleDateString();
  
  // Rank users by activity score
  const rankedUsers = Object.entries(report.users)
    .map(([username, data]) => ({ username, ...data }))
    .sort((a, b) => b.activityScore - a.activityScore);
  
  // Format the message
  let text = `*GitHub Contribution Report*\n`;
  text += `*Period:* ${formattedStartDate} to ${formattedEndDate}\n\n`;
  text += `*Summary:*\n`;
  text += `• Total Commits: ${report.summary.totalCommits}\n`;
  text += `• Total Pull Requests: ${report.summary.totalPRs}\n`;
  text += `• Total Issues: ${report.summary.totalIssues}\n`;
  text += `• Repositories Analyzed: ${report.summary.repositories.length}\n\n`;
  
  // Add AI summary if available
  if (report.aiAnalysis && report.aiAnalysis.summary) {
    text += `*AI Analysis:*\n${report.aiAnalysis.summary}\n\n`;
  }
  
  text += `*Top Contributors This Week:*\n`;
  
  // Add top 5 users
  const topUsers = rankedUsers.slice(0, 5);
  topUsers.forEach((user, index) => {
    text += `${index + 1}. *${user.username}* - Activity Score: ${user.activityScore}\n`;
    text += `   Commits: ${user.totalCommits} | PRs: ${user.totalPRs} | Issues: ${user.totalIssues}\n`;
    
    // Add AI analysis for this user if available
    if (report.aiAnalysis && report.aiAnalysis.contributors && report.aiAnalysis.contributors[user.username]) {
      const userAnalysis = report.aiAnalysis.contributors[user.username];
      
      if (userAnalysis.assessment) {
        text += `   *Assessment:* ${userAnalysis.assessment}\n`;
      }
      
      // Add code insights if available
      if (userAnalysis.codeInsights) {
        text += `   *Code Insights:* ${userAnalysis.codeInsights}\n`;
      }
      
      // Add code quality score if available
      if (userAnalysis.codeQualityScore) {
        text += `   *Code Quality Score:* ${userAnalysis.codeQualityScore}/10\n`;
      }
      
      if (userAnalysis.strengths && userAnalysis.strengths.length > 0) {
        text += `   *Strengths:* ${userAnalysis.strengths.join(', ')}\n`;
      }
      
      if (userAnalysis.areasForImprovement && userAnalysis.areasForImprovement.length > 0) {
        text += `   *Areas for Improvement:* ${userAnalysis.areasForImprovement.join(', ')}\n`;
      }
    }
    
    text += `\n`;
  });
  
  // First try with simple text only, no blocks
  try {
    await client.chat.postMessage({
      channel: channelId,
      text: text
    });
    
    console.log('Successfully posted report to channel without blocks');
    return;
  } catch (error) {
    console.log('Error posting message without blocks, falling back to simpler format:', error.message);
    
    // If that fails, try with minimal blocks
    try {
      const simpleBlocks = [
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": "*GitHub Contribution Report*"
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*Period:* ${formattedStartDate} to ${formattedEndDate}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*Summary:*\n• Total Commits: ${report.summary.totalCommits}\n• Total Pull Requests: ${report.summary.totalPRs}\n• Total Issues: ${report.summary.totalIssues}`
          }
        }
      ];
      
      // Keep it simple
      await client.chat.postMessage({
        channel: channelId,
        text: "GitHub Contribution Report",
        blocks: simpleBlocks
      });
      
      console.log('Successfully posted simplified report to channel');
    } catch (blockError) {
      console.error('Error posting even with simplified blocks:', blockError);
      
      // Last resort: just text with no formatting
      await client.chat.postMessage({
        channel: channelId,
        text: `GitHub Contribution Report for ${formattedStartDate} to ${formattedEndDate}: ${report.summary.totalCommits} commits, ${report.summary.totalPRs} PRs, ${report.summary.totalIssues} issues.`
      });
    }
  }
}

/**
 * Format user report for Slack display
 */
function formatUserReport(userReport) {
  const { user, data, period } = userReport;
  
  const formattedStartDate = new Date(period.startDate).toLocaleDateString();
  const formattedEndDate = new Date(period.endDate).toLocaleDateString();
  
  let text = `*GitHub Contributions for ${user}*\n`;
  text += `*Period:* ${formattedStartDate} to ${formattedEndDate}\n\n`;
  
  text += `*Summary:*\n`;
  text += `• Total Commits: ${data.totalCommits}\n`;
  text += `• Total Pull Requests: ${data.totalPRs}\n`;
  text += `• Total Issues: ${data.totalIssues}\n`;
  text += `• Activity Score: ${data.activityScore}\n\n`;
  
  text += `*Contributions by Repository:*\n`;
  for (const [repo, stats] of Object.entries(data.repositories)) {
    if (stats.commits > 0 || stats.pullRequests > 0 || stats.issues > 0) {
      text += `• *${repo}*\n`;
      text += `  Commits: ${stats.commits} | PRs: ${stats.pullRequests} | Issues: ${stats.issues}\n`;
    }
  }
  
  return text;
}

/**
 * Send weekly report to configured channel
 */
async function sendWeeklyReport() {
  // Generate the report
  const report = await generateContributionReport();
  
  // Save the report
  const savedReport = await saveReport(report);
  
  // Get the Slack client
  const { client } = require('../services/slackService');
  
  // Post to the configured channel
  const channelId = process.env.WEEKLY_REPORT_CHANNEL || process.env.DEFAULT_CHANNEL;
  if (!channelId) {
    throw new Error('No channel configured for weekly reports.');
  }
  
  await postReportToChannel(client, channelId, report, savedReport._id);
  
  return true;
}

/**
 * Get commits from GitHub API
 */
async function getCommits(repos, since, until) {
  console.log(`Fetching commits for ${repos.length} repositories...`);
  
  try {
    const repoCommits = await Promise.all(
      repos.map(async (repo) => {
        const commits = await fetchCommitsForRepo(repo, since, until);
        return { repo, commits };
      })
    );

    // Process all commits from all repos
    const allCommits = [];
    const userCommitMap = {};

    repoCommits.forEach(({ repo, commits }) => {
      commits.forEach(commit => {
        if (!commit.author) return; // Skip commits without author info
        
        const username = commit.author.login;
        if (!username) return; // Skip if no login available
        
        // Add commit to the user's list
        if (!userCommitMap[username]) {
          userCommitMap[username] = [];
        }
        userCommitMap[username].push({
          ...commit,
          repo: {
            owner: repo.owner,
            name: repo.name
          }
        });
        
        // Also add to the overall list
        allCommits.push(commit);
      });
    });

    console.log(`Total commits across all repos: ${allCommits.length}`);
    console.log(`Unique users with commits: ${Object.keys(userCommitMap).length}`);
    
    return { allCommits, userCommitMap };
  } catch (error) {
    console.error('Error fetching commits:', error);
    return { allCommits: [], userCommitMap: {} };
  }
}

/**
 * Get pull requests from GitHub API
 */
async function getPullRequests(owner, repo, since, until) {
  try {
    // GitHub API doesn't filter PRs by date in the same way, so we need to get them all and filter
    let allPRs = [];
    let page = 1;
    let hasMorePages = true;
    
    while (hasMorePages) {
      try {
        const response = await octokit.pulls.list({
          owner,
          repo,
          state: 'all', // Get all PRs to filter by date later
          per_page: 100,
          page
        });
        
        if (response.data.length === 0) {
          hasMorePages = false;
        } else {
          // Filter PRs by creation date
          const filteredPRs = response.data.filter(pr => {
            const createdDate = new Date(pr.created_at);
            return createdDate >= new Date(since) && createdDate <= new Date(until);
          });
          
          allPRs = allPRs.concat(filteredPRs);
          page++;
          
          // If we received less than per_page, we can stop
          if (response.data.length < 100) {
            hasMorePages = false;
          }
        }
      } catch (apiError) {
        // Handle specific GitHub API errors
        if (apiError.status === 403 && apiError.message.includes('rate limit')) {
          console.error(`Rate limit exceeded when fetching PRs for ${owner}/${repo}`);
          hasMorePages = false;
        } else if (apiError.status === 404) {
          console.error(`Repository ${owner}/${repo} not found or no access`);
          hasMorePages = false;
        } else if (apiError.status === 401) {
          console.error(`Authentication error when fetching PRs for ${owner}/${repo}. Check GitHub token.`);
          hasMorePages = false;
        } else {
          console.error(`Error fetching PRs for ${owner}/${repo} (page ${page}):`, apiError);
          hasMorePages = false;
        }
      }
    }
    
    return allPRs;
  } catch (error) {
    console.error(`Error in getPullRequests for ${owner}/${repo}:`, error);
    return [];
  }
}

/**
 * Get issues from GitHub API
 */
async function getIssues(owner, repo, since, until) {
  try {
    console.log(`[ISSUES] Fetching issues for ${owner}/${repo} from ${since} to ${until}`);
    let allIssues = [];
    let page = 1;
    let hasMorePages = true;
    const maxAttempts = 3;
    
    while (hasMorePages) {
      let attempts = 0;
      let success = false;
      
      while (!success && attempts < maxAttempts) {
        try {
          attempts++;
          // Format dates properly to avoid encoding issues
          const sinceDate = new Date(since);
          const sinceIsoString = sinceDate.toISOString();
          
          console.log(`[ISSUES] Fetching page ${page} of issues for ${owner}/${repo} (attempt ${attempts})`);
          
          // Use the new advanced_search parameter
          const response = await octokit.issues.listForRepo({
            owner,
            repo,
            state: 'all',
            since: sinceIsoString,
            per_page: 100,
            page,
            request: {
              timeout: 30000 // 30 second timeout
            }
          });
          
          if (response.data.length === 0) {
            hasMorePages = false;
          } else {
            // Filter by the until date
            const untilDate = new Date(until);
            const filteredIssues = response.data.filter(issue => {
              const createdDate = new Date(issue.created_at);
              return createdDate <= untilDate;
            });
            
            allIssues = allIssues.concat(filteredIssues);
            page++;
            
            // If we received less than per_page, we can stop
            if (response.data.length < 100) {
              hasMorePages = false;
            }
          }
          
          success = true;
          
        } catch (apiError) {
          console.error(`[ERROR] Error fetching issues for ${owner}/${repo} (page ${page}, attempt ${attempts}):`, apiError.message);
          
          // Specific handling for socket hang up errors
          if (apiError.message.includes('socket hang up') || apiError.message.includes('ECONNRESET')) {
            const waitTime = Math.pow(2, attempts) * 1000; // Exponential backoff
            console.log(`[RETRY] Socket error, waiting ${waitTime/1000}s before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
          
          if (apiError.status === 403 && apiError.message.includes('rate limit')) {
            const resetTime = apiError.response?.headers?.['x-ratelimit-reset'];
            if (resetTime) {
              const waitTime = Math.max((resetTime * 1000) - Date.now(), 0) + 1000;
              console.log(`[RATE LIMIT] Rate limit exceeded. Waiting ${waitTime/1000}s before retry...`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
              // Don't increment attempts for rate limit errors
              attempts--;
              continue;
            }
          }
          
          // For other errors, apply exponential backoff
          if (attempts < maxAttempts) {
            const waitTime = Math.pow(2, attempts) * 1000;
            console.log(`[RETRY] Waiting ${waitTime/1000}s before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          } else {
            // If we've failed maxAttempts times, give up on this page
            console.error(`[FAILED] Could not fetch page ${page} of issues after ${maxAttempts} attempts`);
            hasMorePages = false;
          }
        }
      }
    }
    
    console.log(`[SUCCESS] Found ${allIssues.length} issues for ${owner}/${repo}`);
    return allIssues;
  } catch (error) {
    console.error(`[ERROR] Error in getIssues for ${owner}/${repo}:`, error);
    return [];
  }
}

/**
 * Show help message
 */
async function showHelp(respond) {
  const helpText = `
*GitHub Contribution Analysis Bot Help*

*/review generate*
Generate a contribution report for all users in all repositories

*/review user [username]*
View the contribution details for a specific GitHub user

*/review lastweek*
Show the most recent contribution report

*/review token*
Check GitHub token information (for troubleshooting)

*/review help*
Show this help message
  `;
  
  await respond({
    text: helpText,
    response_type: 'ephemeral'
  });
}

/**
 * Show GitHub token information for debugging
 */
async function handleTokenInfo({ respond }) {
  try {
    // Don't include the actual token in the response for security
    let tokenInfo = "GitHub Token Information:\n";
    
    if (githubToken) {
      tokenInfo += `• Token exists: Yes\n`;
      tokenInfo += `• Token length: ${githubToken.length}\n`;
      
      // Check if token has valid characters
      const validChars = /^[a-zA-Z0-9_\-]+$/;
      const isValidFormat = validChars.test(githubToken);
      tokenInfo += `• Token format valid: ${isValidFormat ? 'Yes' : 'No'}\n`;
      
      // Test the token with a simple API call
      try {
        const response = await octokit.users.getAuthenticated();
        tokenInfo += `• Authentication test: Success\n`;
        tokenInfo += `• Authenticated as: ${response.data.login}\n`;
        
        // Add rate limit info
        const rateLimit = await octokit.rateLimit.get();
        tokenInfo += `• Rate limit: ${rateLimit.data.rate.remaining}/${rateLimit.data.rate.limit}\n`;
        tokenInfo += `• Rate limit resets: ${new Date(rateLimit.data.rate.reset * 1000).toLocaleString()}\n`;
      } catch (error) {
        tokenInfo += `• Authentication test: Failed\n`;
        tokenInfo += `• Error: ${error.message}\n`;
      }
    } else {
      tokenInfo += `• Token exists: No\n`;
      tokenInfo += `• Status: Using unauthenticated client with reduced rate limits\n`;
    }
    
    await respond({
      text: tokenInfo,
      response_type: 'ephemeral'
    });
  } catch (error) {
    console.error('Error checking token info:', error);
    await respond({
      text: `Error checking GitHub token: ${error.message}`,
      response_type: 'ephemeral'
    });
  }
}

// Update PR search to use the non-deprecated API
async function fetchPullRequestsForUser(repo, username, since) {
  try {
    console.log(`Fetching PRs for ${username} in ${repo.owner}/${repo.name}`);
    
    // Use the pulls API instead of search
    const pullRequests = await octokit.paginate(octokit.rest.pulls.list, {
      owner: repo.owner,
      repo: repo.name,
      state: 'all',
      per_page: 100
    });
    
    // Filter by author and date
    const sinceDate = new Date(since);
    const filteredPRs = pullRequests.filter(pr => {
      const prCreatedAt = new Date(pr.created_at);
      return pr.user.login.toLowerCase() === username.toLowerCase() && prCreatedAt >= sinceDate;
    });
    
    console.log(`Found ${filteredPRs.length} PRs for ${username} in ${repo.owner}/${repo.name}`);
    return filteredPRs;
  } catch (error) {
    console.error(`Error fetching PRs for ${username} in ${repo.owner}/${repo.name}:`, error);
    return [];
  }
}

// Update issue search to use the non-deprecated API
async function fetchIssuesForUser(repo, username, since) {
  try {
    console.log(`Fetching issues for ${username} in ${repo.owner}/${repo.name}`);
    
    // Use the issues API instead of search
    const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
      owner: repo.owner,
      repo: repo.name,
      state: 'all',
      creator: username,
      since: since.toISOString(),
      per_page: 100
    });
    
    // Filter out pull requests (they're also returned by the issues API)
    const filteredIssues = issues.filter(issue => !issue.pull_request);
    
    console.log(`Found ${filteredIssues.length} issues for ${username} in ${repo.owner}/${repo.name}`);
    return filteredIssues;
  } catch (error) {
    console.error(`Error fetching issues for ${username} in ${repo.owner}/${repo.name}:`, error);
    return [];
  }
}

module.exports = {
  handleReviewCommand,
  generateContributionReport,
  generateUserContributionReport,
  sendWeeklyReport
};
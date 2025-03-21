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
  // Check if token is valid before creating the clien
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

// In-memory cache for GitHub API responses
const apiCache = {
  commits: new Map(),
  branches: new Map(),
  commitDetails: new Map(),
  pullRequests: new Map(),
  issues: new Map(),
  prFiles: new Map(),
  prReviews: new Map(),

  // Cache expiration in milliseconds (30 minutes)
  CACHE_TTL: 30 * 60 * 1000,

  // Get item from cache with key
  get(cacheType, key) {
    const cache = this[cacheType];
    if (!cache) return null;

    const item = cache.get(key);
    if (!item) return null;

    // Check if cache item has expired
    if (Date.now() > item.expiresAt) {
      cache.delete(key);
      return null;
    }

    console.log(`Cache HIT: ${cacheType} - ${key}`);
    return item.data;
  },

  // Set item in cache with key
  set(cacheType, key, data) {
    const cache = this[cacheType];
    if (!cache) return;

    const expiresAt = Date.now() + this.CACHE_TTL;
    console.log(`Cache SET: ${cacheType} - ${key}`);
    cache.set(key, { data, expiresAt });
  },

  // Clear all caches or a specific cache
  clear(cacheType = null) {
    if (cacheType) {
      const cache = this[cacheType];
      if (cache) cache.clear();
    } else {
      this.commits.clear();
      this.branches.clear();
      this.commitDetails.clear();
      this.pullRequests.clear();
      this.issues.clear();
      this.prFiles.clear();
      this.prReviews.clear();
    }
  }
};

/**
 * Helper function to split an array into chunks of specified size
 * Used for parallel processing with controlled concurrency
 */
function chunkArray(array, chunkSize) {
  if (!array || !Array.isArray(array)) return [];
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Initialize user stats in the contributions objec
 */
function initializeUserStats(usersObj, username) {
  if (!usersObj[username]) {
    usersObj[username] = {
      totalCommits: 0,
      totalPRs: 0,
      totalIssues: 0,
      linesAdded: 0,
      linesDeleted: 0,
      linesModified: 0,
      activityScore: 0,
      codeQualityGrade: 'N/A',
      effortGrade: 'N/A',
      repositories: {}
    };
  }

  // Ensure all repositories have stats initialized for this user
  // This function is called when processing per-repo stats
  const repoKey = arguments[2]; // Optional third parameter
  if (repoKey && !usersObj[username].repositories[repoKey]) {
    usersObj[username].repositories[repoKey] = {
      commits: 0,
      pullRequests: 0,
      issues: 0,
      linesAdded: 0,
      linesDeleted: 0,
      linesModified: 0
    };
  }
}

// Parse repositories from environment variable or use defaults
function parseRepositories() {
  try {
    // Check if GITHUB_REPOS is defined in the environmen
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

    // Default repositories if not configured or invalid forma
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
    // Immediately acknowledge the command to prevent timeou
    await respond({
      text: 'Starting GitHub contribution report generation...\n\nThis process can take a while to complete. You will not see a "failed with operation_timeout" message, and the report will be posted to the channel when ready.',
      response_type: 'ephemeral'
    });

    // Run the report generation in the background (no await)
    generateAndPostReport(client, channelId, respond)
      .catch(error => {
        console.error('Error in background report generation:', error);
      });

    // Function exits immediately after acknowledgmen
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
    // Skip detailed content and AI analysis for faster performance
    const originalSkipDetailedContent = process.env.SKIP_DETAILED_CONTENT;
    const originalSkipAIAnalysis = process.env.SKIP_AI_ANALYSIS;

    process.env.SKIP_DETAILED_CONTENT = 'true';
    process.env.SKIP_AI_ANALYSIS = 'true';

    // Generate the report with optimizations
    console.time('slackCommandReportGeneration');
    const report = await generateContributionReport();
    console.timeEnd('slackCommandReportGeneration');

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
    // Try to notify about error
    try {
      await respond({
        text: 'An error occurred while generating the GitHub contribution report. Please try again or use the API endpoint.',
        response_type: 'ephemeral'
      });
    } catch (respondError) {
      console.log('Could not send error message (expected if too much time passed):', respondError.message);
    }
  } finally {
    // Restore original environment variables
    if (originalSkipDetailedContent) {
      process.env.SKIP_DETAILED_CONTENT = originalSkipDetailedContent;
    } else {
      delete process.env.SKIP_DETAILED_CONTENT;
    }

    if (originalSkipAIAnalysis) {
      process.env.SKIP_AI_ANALYSIS = originalSkipAIAnalysis;
    } else {
      delete process.env.SKIP_AI_ANALYSIS;
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
    // Immediately acknowledge the command to prevent timeou
    await respond({
      text: `Starting GitHub contribution report generation for ${username}...\n\nThis process might take a moment. The report will be sent when complete.`,
      response_type: 'ephemeral'
    });

    // Run the user report generation in the background
    generateAndSendUserReport(username, respond, client, userId)
      .catch(error => {
        console.error(`Error in background user report generation for ${username}:`, error);
      });

    // Function exits immediately after acknowledgmen
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

    // Format the user repor
    const formattedReport = formatUserReport(report);

    // Send the report as a direct message instead of ephemeral response
    // This ensures the user gets the report even if the original response times ou
    try {
      await client.chat.postMessage({
        channel: userId,
        text: `Here's your requested report for user ${username}:`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: formattedRepor
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
 * Show previous week's repor
 */
async function handleLastWeekReport({ args, userId, teamId, channelId, respond, client }) {
  try {
    // Immediately acknowledge the command to prevent timeou
    await respond({
      text: 'Retrieving previous report... The report will be posted to the channel shortly.',
      response_type: 'ephemeral'
    });

    // Run the last week report retrieval in the background
    retrieveAndPostLastReport(client, channelId, respond)
      .catch(error => {
        console.error('Error in background last week report retrieval:', error);
      });

    // Function exits immediately after acknowledgmen
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
    // Find the most recent repor
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
   - Strengths and potential areas for improvemen
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
              content: promp
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
    const repoKey = `${owner}/${repo}`;

    // PERFORMANCE OPTIMIZATION: Check if we should fetch detailed conten
    // Skip if we're generating a basic report without AI analysis
    if (process.env.SKIP_DETAILED_CONTENT === 'true') {
      console.log(`Skipping detailed content fetching for ${owner}/${repo} (SKIP_DETAILED_CONTENT is true)`);
      return true;
    }

    // Get the users who have contributed to this repo
    const contributors = contributions.repositories[repoKey]?.contributors || [];

    // OPTIMIZATION: Skip if no contributors
    if (contributors.length === 0) {
      console.log(`No contributors for ${owner}/${repo}, skipping detailed content fetch`);
      return true;
    }

    // OPTIMIZATION: If more than 10 contributors, only process the top 10 by commit coun
    let processedContributors = [...contributors];
    if (contributors.length > 10) {
      // Sort contributors by commit coun
      processedContributors = contributors
        .map(username => ({
          username,
          commits: contributions.users[username]?.repositories[repoKey]?.commits || 0
        }))
        .sort((a, b) => b.commits - a.commits)
        .slice(0, 10) // Only top 10
        .map(contributor => contributor.username);

      console.log(`Optimizing: Processing only top 10 contributors out of ${contributors.length} for ${owner}/${repo}`);
    }

    // Process contributors in parallel with a concurrency limi
    const concurrencyLimit = 5; // Increased from 3 to 5 for better performance
    const contributorChunks = chunkArray(processedContributors, concurrencyLimit);

    for (const contributorChunk of contributorChunks) {
      await Promise.all(contributorChunk.map(async (username) => {
        const user = contributions.users[username];
        if (!user) return; // Skip if user not found

        if (!user.codeContent) {
          user.codeContent = {
            commitDetails: [],
            prDetails: [],
            issueDetails: []
          };
        }

        // Check if this user has contributions in this repo
        const repoStats = user.repositories[repoKey];
        if (!repoStats) return; // Skip if no repo stats

        // OPTIMIZATION: Skip if no commits, PRs, or issues
        if (repoStats.commits <= 0 && repoStats.pullRequests <= 0 && repoStats.issues <= 0) {
          return;
        }

        // Fetch detailed user content in parallel - with early return optimization
        await Promise.all([
          // Fetch commit details if user has commits in this repo
          (async () => {
            if (repoStats.commits <= 0) return;

            try {
              // OPTIMIZATION: Check if we already have cached commits for this repo/time period
              // and just filter by author instead of fetching all commits again
              const allRepoCommits = apiCache.get(
                'commits',
                `${owner}/${repo}:${contributions.summary.period.startDate}:${contributions.summary.period.endDate}`
              );

              let userCommits;
              if (allRepoCommits) {
                // Filter from cached commits
                console.log(`Using cached commits for ${username} in ${owner}/${repo}`);
                userCommits = allRepoCommits.filter(commit =>
                  (commit.author?.login === username) ||
                  (commit.commit?.author?.name === username)
                ).slice(0, 5);
              } else {
                // Fallback to fetching specific user commits
                const commits = await fetchCommitsForRepo(
                  { owner, name: repo },
                  new Date(contributions.summary.period.startDate),
                  new Date(contributions.summary.period.endDate)
                );

                // Filter commits by author
                userCommits = commits.filter(commit =>
                  (commit.author?.login === username) ||
                  (commit.commit?.author?.name === username)
                ).slice(0, 5); // Limit to 5 commits for performance
              }

              // OPTIMIZATION: Skip if no commits for this user
              if (userCommits.length === 0) {
                console.log(`No commits found for ${username} in ${owner}/${repo}, skipping commit details`);
                return;
              }

              // Fetch commit details in parallel (with caching and batch limits)
              const commitChunks = chunkArray(userCommits, 5); // Increased batch size for better performance

              for (const commitChunk of commitChunks) {
                const commitDetailPromises = commitChunk.map(async (commit) => {
                  try {
                    // Check if commit details are in cache
                    const cacheKey = `${owner}/${repo}:${commit.sha}`;
                    const cachedDetails = apiCache.get('commitDetails', cacheKey);

                    if (cachedDetails) {
                      return cachedDetails;
                    }

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

                    const result = {
                      sha: commit.sha,
                      message: commit.commit.message,
                      date: commit.commit.author.date,
                      fileChanges: fileChanges
                    };

                    // Cache the commit details
                    apiCache.set('commitDetails', cacheKey, result);

                    return result;
                  } catch (error) {
                    console.error(`Error fetching commit details for ${commit.sha}:`, error.message);
                    return null;
                  }
                });

                const commitDetails = await Promise.all(commitDetailPromises);
                // Filter out null results and add to user's commit details
                commitDetails
                  .filter(detail => detail !== null)
                  .forEach(detail => user.codeContent.commitDetails.push(detail));
              }
            } catch (error) {
              console.error(`Error fetching commits by author ${username}:`, error.message);
            }
          })(),

          // Fetch PR details if user has PRs in this repo
          (async () => {
            // OPTIMIZATION: Skip if no PRs or fewer than 1
            if (repoStats.pullRequests <= 0) return;

            try {
              // Create cache key for user PRs
              const prCacheKey = `${owner}/${repo}:${username}:prs`;
              let userPRs = apiCache.get('pullRequests', prCacheKey);

              if (!userPRs) {
                userPRs = await getPullRequestsByUser(owner, repo, username);
                apiCache.set('pullRequests', prCacheKey, userPRs);
              } else {
                console.log(`Using cached PRs for ${username} in ${owner}/${repo}`);
              }

              // OPTIMIZATION: Skip if no PRs found
              if (userPRs.length === 0) {
                console.log(`No PRs found for ${username} in ${owner}/${repo}, skipping PR details`);
                return;
              }

              // Take at most 3 PRs for detailed analysis
              const prsToProcess = userPRs.slice(0, 3);

              // MAJOR OPTIMIZATION: Process all PR details in a single batch rather than chunks
              // This reduces the total number of event loop cycles and improves performance
              const prDetailPromises = prsToProcess.map(async (pr) => {
                try {
                  // Check for cached PR details
                  const prDetailCacheKey = `${owner}/${repo}:pr:${pr.number}`;
                  const cachedPrDetails = apiCache.get('prFiles', prDetailCacheKey);

                  if (cachedPrDetails) {
                    return cachedPrDetails;
                  }

                  // Fetch PR files and reviews in parallel
                  const [prFilesResponse, reviewsResponse] = await Promise.all([
                    octokit.pulls.listFiles({
                      owner,
                      repo,
                      pull_number: pr.number
                    }),
                    octokit.pulls.listReviews({
                      owner,
                      repo,
                      pull_number: pr.number
                    })
                  ]);

                  // Extract relevant information
                  const fileChanges = prFilesResponse.data.map(file => ({
                    filename: file.filename,
                    status: file.status,
                    additions: file.additions,
                    deletions: file.deletions,
                    changes: file.changes
                  }));

                  const reviewSummary = reviewsResponse.data.map(review => ({
                    reviewer: review.user.login,
                    state: review.state,
                    body: review.body && review.body.length > 200
                      ? review.body.substring(0, 200) + '...'
                      : review.body
                  }));

                  const result = {
                    number: pr.number,
                    title: pr.title,
                    state: pr.state,
                    created_at: pr.created_at,
                    fileCount: fileChanges.length,
                    totalChanges: fileChanges.reduce((sum, file) => sum + file.changes, 0),
                    fileChanges: fileChanges.slice(0, 5), // Limit to first 5 files
                    reviews: reviewSummary
                  };

                  // Cache the resul
                  apiCache.set('prFiles', prDetailCacheKey, result);

                  return result;
                } catch (error) {
                  console.error(`Error fetching PR details for #${pr.number}:`, error.message);
                  return null;
                }
              });

              const prDetails = await Promise.all(prDetailPromises);
              // Filter out null results and add to user's PR details
              prDetails
                .filter(detail => detail !== null)
                .forEach(detail => user.codeContent.prDetails.push(detail));
            } catch (error) {
              console.error(`Error fetching PRs by user ${username}:`, error.message);
            }
          })(),

          // Fetch issue details if user has issues in this repo (with optimizations)
          (async () => {
            // OPTIMIZATION: Skip if no issues
            if (repoStats.issues <= 0) return;

            try {
              // Create cache key for user issues
              const issuesCacheKey = `${owner}/${repo}:${username}:issues`;
              let userIssues = apiCache.get('issues', issuesCacheKey);

              if (!userIssues) {
                userIssues = await getIssuesByUser(owner, repo, username);
                apiCache.set('issues', issuesCacheKey, userIssues);
              } else {
                console.log(`Using cached issues for ${username} in ${owner}/${repo}`);
              }

              // Filter out PRs that are also counted as issues
              const filteredIssues = userIssues
                .filter(issue => !issue.pull_request)
                .slice(0, 3); // Limit to 3 issues

              // OPTIMIZATION: Skip if no issues found
              if (filteredIssues.length === 0) {
                console.log(`No issues found for ${username} in ${owner}/${repo}, skipping issue details`);
                return;
              }

              // Batch process all issues at once instead of in separate chunks
              const issueDetailPromises = filteredIssues.map(async (issue) => {
                try {
                  // Check for cached issue details
                  const issueCacheKey = `${owner}/${repo}:issue:${issue.number}`;
                  const cachedIssue = apiCache.get('issues', issueCacheKey);

                  if (cachedIssue) {
                    return cachedIssue;
                  }

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

                  const result = {
                    number: issue.number,
                    title: issue.title,
                    state: issue.state,
                    created_at: issue.created_at,
                    body: issue.body && issue.body.length > 300
                      ? issue.body.substring(0, 300) + '...'
                      : issue.body,
                    comments: commentSummary
                  };

                  // Cache the resul
                  apiCache.set('issues', issueCacheKey, result);

                  return result;
                } catch (error) {
                  console.error(`Error fetching issue details for #${issue.number}:`, error.message);
                  return null;
                }
              });

              const issueDetails = await Promise.all(issueDetailPromises);
              // Filter out null results and add to user's issue details
              issueDetails
                .filter(detail => detail !== null)
                .forEach(detail => user.codeContent.issueDetails.push(detail));
            } catch (error) {
              console.error(`Error fetching issues by user ${username}:`, error.message);
            }
          })()
        ]);
      }));
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
    const maxRetries = 3;

    // Create a cache key for this repository and time range
    const cacheKey = `${repo.owner}/${repo.name}:${since.toISOString()}:${until.toISOString()}`;

    // Check if we have this in cache
    const cachedCommits = apiCache.get('commits', cacheKey);
    if (cachedCommits) {
      console.log(`Using cached commits for ${repo.owner}/${repo.name}`);
      return cachedCommits;
    }

    console.log(`Fetching commits for ${repo.owner}/${repo.name} from ${since.toISOString()} to ${until.toISOString()}`);

    // Get all branches for the repository (with caching)
    let allBranches = [];
    try {
      const branchCacheKey = `${repo.owner}/${repo.name}`;
      const cachedBranches = apiCache.get('branches', branchCacheKey);

      if (cachedBranches) {
        allBranches = cachedBranches;
        console.log(`Using cached branches for ${repo.owner}/${repo.name}: ${allBranches.length} branches`);
      } else {
        console.log(`Getting all branches for ${repo.owner}/${repo.name}`);
        const branchesResponse = await octokit.rest.repos.listBranches({
          owner: repo.owner,
          repo: repo.name,
          per_page: 100
        });

        allBranches = branchesResponse.data.map(branch => branch.name);
        console.log(`Found ${allBranches.length} branches in ${repo.owner}/${repo.name}`);

        // Cache the branches
        apiCache.set('branches', branchCacheKey, allBranches);
      }
    } catch (branchError) {
      console.error(`Error fetching branches for ${repo.owner}/${repo.name}:`, branchError);
      // If we can't get branches, we'll try without specifying branch (default branch only)
      allBranches = [''];  // Empty string will use default branch
    }

    // Important optimization: For most repositories, analyzing just the top 3 active branches
    // gets 99% of commits and is much faster
    if (allBranches.length > 3) {
      // Sort branches starting with main/master first (likely to have most commits)
      const priorityBranches = ['main', 'master', 'develop', 'dev', 'staging', 'production'];
      allBranches.sort((a, b) => {
        const aIndex = priorityBranches.findIndex(name => a.includes(name));
        const bIndex = priorityBranches.findIndex(name => b.includes(name));

        // If both contain priority names, sort by priority
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        // If only a contains priority name, it comes firs
        if (aIndex !== -1) return -1;
        // If only b contains priority name, it comes firs
        if (bIndex !== -1) return 1;
        // Otherwise keep original order
        return 0;
      });

      // Process all branches but keep them in prioritized order
      console.log(`Processing all ${allBranches.length} branches in priority order`);
    }

    // Process branches in parallel with concurrency limit to avoid rate limiting
    // Increase concurrency for better performance since we're checking all branches
    const concurrencyLimit = 5; // Process 5 branches at a time
    const branchChunks = chunkArray(allBranches, concurrencyLimit);

    for (const branchChunk of branchChunks) {
      // Process each chunk of branches in parallel
      const branchCommitsResults = await Promise.all(
        branchChunk.map(branch => fetchCommitsForBranch(repo, branch, since, until, maxRetries))
      );

      // Combine and deduplicate commits
      for (const branchCommits of branchCommitsResults) {
        // Filter to avoid duplicate commits that might appear in multiple branches
        // Note: This is expensive for large repos, use Set for more efficient deduplication
        const uniqueIds = new Set(allCommits.map(commit => commit.sha));
        const newCommits = branchCommits.filter(commit => !uniqueIds.has(commit.sha));

        console.log(`Found ${newCommits.length} new unique commits (filtered out ${branchCommits.length - newCommits.length} duplicates)`);
        allCommits = [...allCommits, ...newCommits];
      }
    }

    console.log(`Total unique commits fetched for ${repo.owner}/${repo.name} across all branches: ${allCommits.length}`);

    // Cache the resul
    apiCache.set('commits', cacheKey, allCommits);

    return allCommits;
  } catch (error) {
    console.error(`Error fetching commits for ${repo.owner}/${repo.name}:`, error);
    return []; // Return empty array on error
  }
}

/**
 * Helper function to fetch commits for a single branch with pagination and retry logic
 */
async function fetchCommitsForBranch(repo, branch, since, until, maxRetries) {
  // Create a cache key for this branch
  const cacheKey = `${repo.owner}/${repo.name}:${branch}:${since.toISOString()}:${until.toISOString()}`;

  // Check cache firs
  const cachedCommits = apiCache.get('commits', cacheKey);
  if (cachedCommits) {
    console.log(`Using cached commits for branch ${branch || 'default'} in ${repo.owner}/${repo.name}`);
    return cachedCommits;
  }

  let allBranchCommits = [];
  let page = 1;
  let hasMoreCommits = true;

  console.log(`Fetching commits for branch: ${branch || 'default'} in ${repo.owner}/${repo.name}`);

  // Use smaller page size in memory-optimized mode
  const isMemoryOptimized = process.env.MEMORY_OPTIMIZED === 'true';
  const pageSize = isMemoryOptimized ? 100 : 250;

  // Get a reasonable max pages limit that balances completeness with performance
  // We prioritize memory optimization if set, otherwise use environment variable or defaul
  const maxPages = isMemoryOptimized ? 2 :
                   process.env.MAX_BRANCH_PAGES ? parseInt(process.env.MAX_BRANCH_PAGES) : 10;

  // First, check if branch has any commits in the time period (fast check with 1 result)
  try {
    const checkResponse = await octokit.rest.repos.listCommits({
      owner: repo.owner,
      repo: repo.name,
      sha: branch,
      since: since.toISOString(),
      until: until.toISOString(),
      per_page: 1
    });

    // If no commits in this time period, skip this branch entirely
    if (checkResponse.data.length === 0) {
      console.log(`Branch ${branch || 'default'} in ${repo.owner}/${repo.name} has no commits in specified time period, skipping`);
      apiCache.set('commits', cacheKey, []); // Cache empty resul
      return [];
    }

    console.log(`Branch ${branch || 'default'} in ${repo.owner}/${repo.name} has commits in time period, fetching all`);
  } catch (error) {
    // If we get an error checking the branch, it might not exist anymore or we don't have access
    console.error(`Error checking commits for branch ${branch || 'default'} in ${repo.owner}/${repo.name}:`, error.message);
    apiCache.set('commits', cacheKey, []); // Cache empty result to avoid retrying
    return [];
  }

  while (hasMoreCommits && page <= maxPages) {
    let retries = 0;
    let success = false;

    while (!success && retries < maxRetries) {
      try {
        console.log(`Fetching page ${page} of commits for ${repo.owner}/${repo.name} branch ${branch || 'default'}`);

        const response = await octokit.rest.repos.listCommits({
          owner: repo.owner,
          repo: repo.name,
          sha: branch,
          since: since.toISOString(),
          until: until.toISOString(),
          per_page: pageSize,
          page
        });

        console.log(`Received ${response.data.length} commits for ${repo.owner}/${repo.name} branch ${branch || 'default'} (page ${page})`);

        if (response.data.length === 0) {
          hasMoreCommits = false;
        } else {
          allBranchCommits = [...allBranchCommits, ...response.data];

          // Performance optimization: if we receive fewer than the page size,
          // we likely have all results and can avoid an extra API call
          if (response.data.length < pageSize) {
            hasMoreCommits = false;
          }

          page++;
        }
        success = true;
      } catch (error) {
        retries++;
        console.log(`Error fetching commits for ${repo.owner}/${repo.name} branch ${branch || 'default'} (page ${page}, attempt ${retries}): ${error.message}`);

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
          console.error(`Failed to fetch commits for ${repo.owner}/${repo.name} branch ${branch || 'default'} (page ${page}) after ${maxRetries} attempts`);
          // Continue to the next branch if we have issues with this one
          hasMoreCommits = false;
        }
      }
    }
  }

  // Cache the results before returning
  apiCache.set('commits', cacheKey, allBranchCommits);

  return allBranchCommits;
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
          linesAdded: data.linesAdded,
          linesDeleted: data.linesDeleted,
          linesModified: data.linesModified,
          repositories: Object.entries(data.repositories)
            .filter(([_, stats]) => stats.commits > 0 || stats.pullRequests > 0 || stats.issues > 0)
            .map(([repo, stats]) => ({
              repo,
              commits: stats.commits,
              pullRequests: stats.pullRequests,
              issues: stats.issues,
              linesAdded: stats.linesAdded,
              linesDeleted: stats.linesDeleted,
              linesModified: stats.linesModified
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
                files: commit.fileChanges && Array.isArray(commit.fileChanges)
                  ? commit.fileChanges
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
                  : []
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
                files: pr.fileChanges && Array.isArray(pr.fileChanges)
                  ? pr.fileChanges
                      .slice(0, 2) // Limit to first 2 files
                      .map(file => ({
                        filename: file.filename,
                        changes: {
                          additions: file.additions,
                          deletions: file.deletions,
                          total: file.changes
                        }
                      }))
                  : [],
                // Include review feedback
                reviews: pr.reviews && Array.isArray(pr.reviews)
                  ? pr.reviews
                      .slice(0, 2) // Limit to first 2 reviews
                      .map(review => ({
                        reviewer: review.reviewer,
                        state: review.state,
                        comment: review.body && review.body.length > 150
                          ? review.body.substring(0, 150) + '...'
                          : review.body
                      }))
                  : []
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
                comments: issue.comments && Array.isArray(issue.comments)
                  ? issue.comments
                      .slice(0, 2) // Limit to first 2 comments
                      .map(comment => ({
                        user: comment.user,
                        content: comment.body && comment.body.length > 150
                          ? comment.body.substring(0, 150) + '...'
                          : comment.body
                      }))
                  : []
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

    // Anthropic Claude API endpoin
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
   - Technical strengths and areas for improvemen
   - Specific insights based on their code, PR, and issue conten
   - A letter grade for code quality (A+, A, A-, B+, B, etc.)
   - A letter grade for effort shown over the past week

Contribution data for the past week:
${JSON.stringify(contributors, null, 2)}

IMPORTANT:
- Evaluate both quantity AND quality of contributions
- Examine actual code samples when available
- Look for patterns in PR reviews and comments
- Consider issue descriptions and level of detail
- Keep each contributor's analysis concise (3-5 sentences maximum)
- For effort grade, consider: lines of code added/modified, number and complexity of PRs, and overall activity
- For code quality grade, consider: code organization, complexity management, and readability

Respond in this JSON format:
{
  "summary": "Overall team activity summary with code quality assessment",
  "contributors": {
    "username1": {
      "assessment": "Concise assessment of contribution pattern and code quality",
      "codeInsights": "Specific observations about their code style, quality, and patterns",
      "strengths": ["Technical strength 1", "Technical strength 2"],
      "areasForImprovement": ["Technical area 1", "Technical area 2"],
      "codeQualityScore": 8.5,
      "codeQualityGrade": "B+",
      "effortGrade": "A-"
    },
    ...
  }
}

For codeQualityScore, use a scale of 1-10 where:
1-3: Needs significant improvement (D or F grade)
4-6: Average quality code (C grade)
7-8: Good quality code with minor issues (B grade)
9-10: Excellent, well-structured, maintainable code (A grade)

For letter grades:
A+: Exceptional
A: Excellen
A-: Very good
B+: Good with some notable strengths
B: Solid, good
B-: Slightly above average
C+: Average with some positive aspects
C: Average
C-: Below average but acceptable
D+: Barely acceptable
D: Poor
F: Failing/Unacceptable`;

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
              content: promp
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
  console.time('totalReportGeneration'); // Performance measuremen

  // CLOUD RUN FIX: Clear the cache before generating a new report to prevent memory buildup
  console.log('Clearing cache before generating new report');
  apiCache.clear();

  // Force garbage collection if available (Node.js with --expose-gc flag)
  if (global.gc) {
    console.log('Running garbage collection');
    global.gc();
  }

  // Set memory optimization options if not already se
  const isMemoryOptimized = process.env.MEMORY_OPTIMIZED === 'true';
  if (isMemoryOptimized) {
    console.log('Running in memory-optimized mode for Cloud Run');
  }

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
      totalLinesAdded: 0,
      totalLinesDeleted: 0,
      totalLinesModified: 0,
      prsMerged: 0,
      issuesClosed: 0,
      repositories: REPOS.map(r => `${r.owner}/${r.repo}`),
      period: {
        startDate: since,
        endDate: until
      }
    },
    users: {},
    repositories: {}
  };

  console.log(`Starting parallel processing of ${REPOS.length} repositories...`);

  // OPTIMIZATION: Sort repositories by priority - this focuses on the most important repos firs
  // and increases the chances of having useful data even if the process is interrupted
  const priorityRepos = REPOS.sort((a, b) => {
    const primaryRepos = ['arch-network']; // Add your most important repositories here
    const aIndex = primaryRepos.indexOf(a.repo);
    const bIndex = primaryRepos.indexOf(b.repo);

    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    return 0;
  });

  // In Cloud Run, limit the number of repositories processed for better performance
  let reposToProcess = priorityRepos;
  if (isMemoryOptimized) {
    // When running in Cloud Run, only process top repositories
    const maxRepos = parseInt(process.env.MAX_REPOS || '3', 10);
    reposToProcess = priorityRepos.slice(0, maxRepos);
    console.log(`Memory optimization: Processing only top ${reposToProcess.length} repositories instead of ${priorityRepos.length}`);
  }

  // Process repositories in parallel with a concurrency limi
  const concurrencyLimit = isMemoryOptimized ? 2 : 5; // Lower concurrency in Cloud Run
  const repoChunks = chunkArray(reposToProcess, concurrencyLimit);

  for (const repoChunk of repoChunks) {
    console.time(`repoChunk_${repoChunk.map(r => r.repo).join('_')}`); // Performance tracking

    // Process each chunk of repositories in parallel
    await Promise.all(repoChunk.map(async ({ owner, repo }) => {
      console.log(`Processing repository: ${owner}/${repo}`);
      console.time(`repo_${owner}_${repo}`); // Track per-repository timing

      const repoKey = `${owner}/${repo}`;

      // Initialize repository data
      contributions.repositories[repoKey] = {
        commits: 0,
        pullRequests: 0,
        issues: 0,
        prsMerged: 0,
        issuesClosed: 0,
        linesAdded: 0,
        linesDeleted: 0,
        linesModified: 0,
        contributors: []
      };

      try {
        // Fetch commits, PRs, and issues in parallel (major optimization)
        const [commits, prs, issues] = await Promise.all([
          fetchCommitsForRepo({ owner, name: repo }, new Date(since), new Date(until)),
          getPullRequests(owner, repo, since, until),
          getIssues(owner, repo, since, until)
        ]);

        // Process all data in parallel
        await Promise.all([
          // Process commits
          (async () => {
            console.time(`commits_${owner}_${repo}`);

            contributions.summary.totalCommits += commits.length;
            contributions.repositories[repoKey].commits = commits.length;

            // OPTIMIZATION: Skip author processing if no commits
            if (commits.length === 0) {
              console.log(`No commits found for ${owner}/${repo}, skipping commit processing`);
              console.timeEnd(`commits_${owner}_${repo}`);
              return;
            }

            // OPTIMIZATION: Create a map of authors to avoid redundant lookups
            const authors = new Map();
            for (const commit of commits) {
              const author = commit.author?.login || commit.commit?.author?.name || 'Unknown';
              if (!authors.has(author)) {
                authors.set(author, []);
              }
              authors.get(author).push(commit);
            }

            // Process commits by author in parallel
            await Promise.all(Array.from(authors.entries()).map(async ([author, authorCommits]) => {
              // Initialize user stats if not already done
              if (!contributions.users[author]) {
                initializeUserStats(contributions.users, author);
              }

              // Initialize repository for this user if not already done
              if (!contributions.users[author].repositories[repoKey]) {
                initializeUserStats(contributions.users, author, repoKey);
              }

              // Update commit counts
              contributions.users[author].totalCommits += authorCommits.length;
              contributions.users[author].repositories[repoKey].commits += authorCommits.length;

              // Add contributor to repo's list if not already there
              if (!contributions.repositories[repoKey].contributors.includes(author)) {
                contributions.repositories[repoKey].contributors.push(author);
              }

              // OPTIMIZATION: Use a smaller sample of commits for line stats to improve performance
              // Skip if the author has more than 20 commits, we'll just analyze a sample
              const commitsToAnalyze = authorCommits.length > 20
                ? authorCommits.slice(0, 20) // Sample the first 20 commits
                : authorCommits;

              // OPTIMIZATION: Process commit details in batches
              const commitBatchSize = 5;
              const commitBatches = chunkArray(commitsToAnalyze, commitBatchSize);

              for (const batch of commitBatches) {
                await Promise.all(batch.map(async (commit) => {
                  try {
                    // Check cache for commit details
                    const cacheKey = `${owner}/${repo}:${commit.sha}`;
                    let commitData = apiCache.get('commitDetails', cacheKey);

                    if (!commitData) {
                      // Fetch from API if not in cache
                      const response = await octokit.repos.getCommit({
                        owner,
                        repo,
                        ref: commit.sha
                      });
                      commitData = response.data;

                      // Cache the resul
                      apiCache.set('commitDetails', cacheKey, commitData);
                    }

                    // Extract stats for lines added/deleted
                    const files = commitData.files || [];
                    let commitLinesAdded = 0;
                    let commitLinesDeleted = 0;

                    for (const file of files) {
                      commitLinesAdded += file.additions || 0;
                      commitLinesDeleted += file.deletions || 0;
                    }

                    // Update user stats
                    contributions.users[author].linesAdded += commitLinesAdded;
                    contributions.users[author].linesDeleted += commitLinesDeleted;
                    contributions.users[author].linesModified += (commitLinesAdded + commitLinesDeleted);

                    // Update repo user stats
                    contributions.users[author].repositories[repoKey].linesAdded += commitLinesAdded;
                    contributions.users[author].repositories[repoKey].linesDeleted += commitLinesDeleted;
                    contributions.users[author].repositories[repoKey].linesModified += (commitLinesAdded + commitLinesDeleted);

                    // Update repo and summary total stats
                    contributions.repositories[repoKey].linesAdded += commitLinesAdded;
                    contributions.repositories[repoKey].linesDeleted += commitLinesDeleted;
                    contributions.repositories[repoKey].linesModified += (commitLinesAdded + commitLinesDeleted);
                    contributions.summary.totalLinesAdded += commitLinesAdded;
                    contributions.summary.totalLinesDeleted += commitLinesDeleted;
                    contributions.summary.totalLinesModified += (commitLinesAdded + commitLinesDeleted);
                  } catch (error) {
                    console.error(`Error fetching commit details for ${commit.sha}:`, error.message);
                  }
                }));
              }
            }));

            console.timeEnd(`commits_${owner}_${repo}`);
          })(),

          // Process PRs
          (async () => {
            console.time(`prs_${owner}_${repo}`);

            contributions.summary.totalPRs += prs.length;
            contributions.repositories[repoKey].pullRequests = prs.length;

            // Count merged PRs
            const mergedPRs = prs.filter(pr => pr.merged_at !== null);
            contributions.summary.prsMerged += mergedPRs.length;
            contributions.repositories[repoKey].prsMerged = mergedPRs.length;

            // OPTIMIZATION: Skip if no PRs
            if (prs.length === 0) {
              console.log(`No PRs found for ${owner}/${repo}, skipping PR processing`);
              console.timeEnd(`prs_${owner}_${repo}`);
              return;
            }

            // OPTIMIZATION: Group PRs by author
            const prsByAuthor = new Map();
            for (const pr of prs) {
              const author = pr.user.login;
              if (!prsByAuthor.has(author)) {
                prsByAuthor.set(author, []);
              }
              prsByAuthor.get(author).push(pr);
            }

            // Process PRs by user in parallel
            await Promise.all(Array.from(prsByAuthor.entries()).map(async ([author, authorPRs]) => {
              if (!contributions.users[author]) {
                initializeUserStats(contributions.users, author);
              }

              // Initialize repository for this user if not already done
              if (!contributions.users[author].repositories[repoKey]) {
                initializeUserStats(contributions.users, author, repoKey);
              }

              contributions.users[author].totalPRs += authorPRs.length;
              contributions.users[author].repositories[repoKey].pullRequests += authorPRs.length;

              // Add contributor to repo's list if not already there
              if (!contributions.repositories[repoKey].contributors.includes(author)) {
                contributions.repositories[repoKey].contributors.push(author);
              }
            }));

            console.timeEnd(`prs_${owner}_${repo}`);
          })(),

          // Process issues
          (async () => {
            console.time(`issues_${owner}_${repo}`);

            // OPTIMIZATION: Skip issues processing if none found
            if (issues.length === 0) {
              console.log(`No issues found for ${owner}/${repo}, skipping issue processing`);
              console.timeEnd(`issues_${owner}_${repo}`);
              return;
            }

            // Filter out pull requests that are also counted as issues
            const actualIssues = issues.filter(issue => !issue.pull_request);

            contributions.summary.totalIssues += actualIssues.length;
            contributions.repositories[repoKey].issues = actualIssues.length;

            // Count closed issues
            const closedIssues = actualIssues.filter(issue => issue.state === 'closed');
            contributions.summary.issuesClosed += closedIssues.length;
            contributions.repositories[repoKey].issuesClosed = closedIssues.length;

            // OPTIMIZATION: Group issues by author
            const issuesByAuthor = new Map();
            for (const issue of actualIssues) {
              const author = issue.user.login;
              if (!issuesByAuthor.has(author)) {
                issuesByAuthor.set(author, []);
              }
              issuesByAuthor.get(author).push(issue);
            }

            // Process issues by user in parallel
            await Promise.all(Array.from(issuesByAuthor.entries()).map(async ([author, authorIssues]) => {
              if (!contributions.users[author]) {
                initializeUserStats(contributions.users, author);
              }

              // Initialize repository for this user if not already done
              if (!contributions.users[author].repositories[repoKey]) {
                initializeUserStats(contributions.users, author, repoKey);
              }

              contributions.users[author].totalIssues += authorIssues.length;
              contributions.users[author].repositories[repoKey].issues += authorIssues.length;

              // Add contributor to repo's list if not already there
              if (!contributions.repositories[repoKey].contributors.includes(author)) {
                contributions.repositories[repoKey].contributors.push(author);
              }
            }));

            console.timeEnd(`issues_${owner}_${repo}`);
          })()
        ]);

      } catch (error) {
        console.error(`Error processing repository ${owner}/${repo}:`, error);
      }

      console.timeEnd(`repo_${owner}_${repo}`);
    }));

    console.timeEnd(`repoChunk_${repoChunk.map(r => r.repo).join('_')}`);
  }

  // OPTIMIZATION: Make detailed content fetching optional and controlled by env var
  if (process.env.SKIP_DETAILED_CONTENT !== 'true') {
    console.log('Fetching detailed content for all repositories...');
    console.time('detailedContentFetch');

    // Fetch detailed content for commits, PRs, and issues in parallel
    await Promise.all(REPOS.map(async ({ owner, repo }) => {
      await fetchDetailedContent(owner, repo, contributions);
    }));

    console.timeEnd('detailedContentFetch');
  } else {
    console.log('Skipping detailed content fetching (SKIP_DETAILED_CONTENT=true)');
  }

  // Calculate activity scores and assign grades
  for (const username in contributions.users) {
    const user = contributions.users[username];

    // Simple weighted score: commits are worth 3, PRs are worth 5, issues are worth 1
    user.activityScore = (user.totalCommits * 3) + (user.totalPRs * 5) + (user.totalIssues * 1);

    // Assign effort grade based on lines modified and activity score
    user.effortGrade = calculateEffortGrade(user.linesModified, user.activityScore);
  }

  // Generate AI analysis if set in environment (can be disabled for faster reports)
  if (process.env.SKIP_AI_ANALYSIS !== 'true') {
    console.time('aiAnalysis');
    // Generate detailed AI analysis if possible (with code content)
    const aiAnalysis = await generateDetailedAIAnalysis(contributions);
    if (aiAnalysis) {
      contributions.aiAnalysis = aiAnalysis;

      // Add code quality grades from AI analysis
      if (aiAnalysis.contributors) {
        for (const username in aiAnalysis.contributors) {
          if (contributions.users[username] && aiAnalysis.contributors[username].codeQualityScore) {
            const codeQualityScore = aiAnalysis.contributors[username].codeQualityScore;
            contributions.users[username].codeQualityGrade = convertScoreToGrade(codeQualityScore);
          }
        }
      }
    } else {
      // Fall back to basic analysis if detailed analysis fails
      const basicAnalysis = await generateAIAnalysis(contributions);
      if (basicAnalysis) {
        contributions.aiAnalysis = basicAnalysis;
      }
    }
    console.timeEnd('aiAnalysis');
  } else {
    console.log('Skipping AI analysis (SKIP_AI_ANALYSIS=true)');
  }

  console.timeEnd('totalReportGeneration');
  return contributions;
}

/**
 * Format team stats as a Slack-compatible markdown table
 */
function formatTeamStatsTable(summary) {
  let table = "```\n";
  table += "| Metric                | Value            |\n";
  table += "|----------------------|------------------|\n";
  table += `| Total Commits         | ${summary.totalCommits.toString().padEnd(16)} |\n`;
  table += `| Lines of Code Added   | ${summary.totalLinesAdded.toString().padEnd(16)} |\n`;
  table += `| PRs Opened            | ${summary.totalPRs.toString().padEnd(16)} |\n`;
  table += `| PRs Merged            | ${summary.prsMerged.toString().padEnd(16)} |\n`;
  table += `| Issues Opened         | ${summary.totalIssues.toString().padEnd(16)} |\n`;
  table += `| Issues Closed         | ${summary.issuesClosed.toString().padEnd(16)} |\n`;
  table += "```";

  return table;
}

/**
 * Format individual developer stats as a Slack-compatible markdown table
 */
function formatIndividualStatsTable(users) {
  // Rank users by activity score
  const rankedUsers = Object.entries(users)
    .map(([username, data]) => ({ username, ...data }))
    .sort((a, b) => b.activityScore - a.activityScore);

  let table = "```\n";
  table += "| Developer       | Commits | Lines Added/Modified | Code Quality | Effort Grade |\n";
  table += "|-----------------|---------|----------------------|-------------|-------------|\n";

  for (const user of rankedUsers) {
    const username = user.username.padEnd(15).substring(0, 15);
    const commits = user.totalCommits.toString().padEnd(7);
    const linesChanged = `${user.linesAdded}/${user.linesModified}`.padEnd(20);
    const codeQuality = user.codeQualityGrade.padEnd(11);
    const effortGrade = user.effortGrade.padEnd(11);

    table += `| ${username} | ${commits} | ${linesChanged} | ${codeQuality} | ${effortGrade} |\n`;
  }

  table += "```";

  return table;
}

/**
 * Show help message
 */
async function showHelp(respond) {
  const helpText = `
*GitHub Contribution Analysis Bot Help*

*/review generate*
Generate a contribution report for all users in all repositories.
Shows team stats (commits, lines of code, PRs opened/merged, issues opened/closed) and individual developer stats (commits, lines modified, code quality and effort grades).

*/review user [username]*
View the detailed contribution details for a specific GitHub user

*/review lastweek*
Show the most recent contribution repor

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
  text += `• Lines Added: ${data.linesAdded}\n`;
  text += `• Lines Modified: ${data.linesModified}\n`;
  text += `• Code Quality Grade: ${data.codeQualityGrade}\n`;
  text += `• Effort Grade: ${data.effortGrade}\n`;
  text += `• Activity Score: ${data.activityScore}\n\n`;

  text += `*Contributions by Repository:*\n`;
  for (const [repo, stats] of Object.entries(data.repositories)) {
    if (stats.commits > 0 || stats.pullRequests > 0 || stats.issues > 0) {
      text += `• *${repo}*\n`;
      text += `  Commits: ${stats.commits} | PRs: ${stats.pullRequests} | Issues: ${stats.issues} | Lines: ${stats.linesAdded}/${stats.linesModified}\n`;
    }
  }

  return text;
}

/**
 * Send weekly report to configured channel
 */
async function sendWeeklyReport() {
  // Generate the repor
  const report = await generateContributionReport();

  // Save the repor
  const savedReport = await saveReport(report);

  // Get the Slack clien
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

        // Add commit to the user's lis
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

        // Also add to the overall lis
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
              timeout: 30000 // 30 second timeou
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
 * Generate contribution report for a specific user across all repositories
 */
async function generateUserContributionReport(username) {
  console.log(`Generating user contribution report for ${username}`);

  // Get contributions from the last 7 days
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);

  // Format dates for GitHub API
  const since = startDate.toISOString();
  const until = endDate.toISOString();

  // Parse repositories from environmen
  const repositories = parseRepositories();

  // Process each repository to find user contributions
  const userContributions = {
    username: username,
    repositories: [],
    period: {
      startDate: since,
      endDate: until
    },
    summary: {
      totalCommits: 0,
      totalPRs: 0,
      totalIssues: 0
    }
  };

  // Process each repository in sequence to avoid rate limits
  for (const repo of repositories) {
    try {
      console.log(`Processing ${repo.owner}/${repo.name} for user ${username}`);

      // Get commits by author
      const commits = await getCommitsByAuthor(repo.owner, repo.name, username);

      // Filter commits by date range
      const filteredCommits = commits.filter(commit => {
        const commitDate = new Date(commit.commit.author.date);
        return commitDate >= startDate && commitDate <= endDate;
      });

      // Get PRs by user
      const prs = await getPullRequestsByUser(repo.owner, repo.name, username);

      // Filter PRs by date range
      const filteredPRs = prs.filter(pr => {
        const prDate = new Date(pr.created_at);
        return prDate >= startDate && prDate <= endDate;
      });

      // Get issues by user
      const issues = await getIssuesByUser(repo.owner, repo.name, username);

      // Filter issues by date range
      const filteredIssues = issues.filter(issue => {
        const issueDate = new Date(issue.created_at);
        return issueDate >= startDate && issueDate <= endDate;
      });

      // Add repository to user contributions if there's activity
      if (filteredCommits.length > 0 || filteredPRs.length > 0 || filteredIssues.length > 0) {
        userContributions.repositories.push({
          name: `${repo.owner}/${repo.name}`,
          commits: filteredCommits.length,
          pullRequests: filteredPRs.length,
          issues: filteredIssues.length
        });

        // Update summary counts
        userContributions.summary.totalCommits += filteredCommits.length;
        userContributions.summary.totalPRs += filteredPRs.length;
        userContributions.summary.totalIssues += filteredIssues.length;
      }
    } catch (error) {
      console.error(`Error processing ${repo.owner}/${repo.name} for user ${username}:`, error);
    }
  }

  return userContributions;
}

/**
 * Calculate effort grade based on lines modified and activity score
 * @param {number} linesModified - Total lines modified
 * @param {number} activityScore - Activity score
 * @returns {string} Letter grade
 */
function calculateEffortGrade(linesModified, activityScore) {
  // Calculate effort grade based on lines modified and activity score
  if (linesModified > 1000 || activityScore > 50) return 'A+';
  if (linesModified > 750 || activityScore > 40) return 'A';
  if (linesModified > 500 || activityScore > 30) return 'A-';
  if (linesModified > 300 || activityScore > 20) return 'B+';
  if (linesModified > 200 || activityScore > 15) return 'B';
  if (linesModified > 100 || activityScore > 10) return 'B-';
  if (linesModified > 50 || activityScore > 5) return 'C+';
  if (linesModified > 25 || activityScore > 3) return 'C';
  if (linesModified > 10 || activityScore > 1) return 'C-';
  return 'D';
}

/**
 * Convert numeric score to letter grade
 * @param {number} score - Score from 1-10
 * @returns {string} Letter grade
 */
function convertScoreToGrade(score) {
  if (score >= 9.5) return 'A+';
  if (score >= 9.0) return 'A';
  if (score >= 8.5) return 'A-';
  if (score >= 8.0) return 'B+';
  if (score >= 7.5) return 'B';
  if (score >= 7.0) return 'B-';
  if (score >= 6.5) return 'C+';
  if (score >= 6.0) return 'C';
  if (score >= 5.5) return 'C-';
  if (score >= 5.0) return 'D+';
  if (score >= 4.0) return 'D';
  return 'F';
}

/**
 * Save contribution report to database
 * @param {Object} report - The contribution report to save
 * @returns {Promise<Object>} - The saved report documen
 */
async function saveReport(report) {
  try {
    const contributionReport = new ContributionReport({
      data: report,
      createdAt: new Date()
    });
    return await contributionReport.save();
  } catch (error) {
    console.error('Error saving report to database:', error);
    // Return a minimal object with an _id to prevent further errors
    return { _id: 'error-saving-report' };
  }
}

/**
 * Post report summary to Slack channel
 * @param {Object} client - Slack clien
 * @param {string} channelId - Channel to post to
 * @param {Object} report - Contribution report data
 * @param {string} reportId - Database ID of the saved repor
 */
async function postReportToChannel(client, channelId, report, reportId) {
  try {
    // Format data for Slack message
    const summaryTable = formatTeamStatsTable(report.summary);
    const individualTable = formatIndividualStatsTable(report.users);

    // Post message to channel
    await client.chat.postMessage({
      channel: channelId,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "📊 GitHub Contribution Report",
            emoji: true
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Period:* ${report.summary.period.startDate} to ${report.summary.period.endDate}`
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: summaryTable
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: individualTable
          }
        }
      ]
    });
  } catch (error) {
    console.error('Error posting report to channel:', error);
  }
}

module.exports = {
  handleReviewCommand,
  generateContributionReport,
  generateUserContributionReport,
  sendWeeklyReport,
  saveReport,
  postReportToChannel,
  handleGenerateReport,
  handleUserReport,
  handleLastWeekReport,
  handleTokenInfo
};
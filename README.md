# GitHub Contribution Analyzer Bot

A Slack bot that analyzes GitHub contributions across repositories to help technical managers evaluate work efficiency and track progress.

## Features

- Analyzes GitHub activity across multiple repositories
  - Tracks commits, pull requests, and issues
  - Calculates activity scores for users
  - Ranks contributors by productivity
- Generates comprehensive reports with interactive components
  - View details for specific users
  - See repository-specific statistics
  - Access historical report data
- Supports weekly automated reports
- Supports on-demand analysis

## Repositories Analyzed

The bot analyzes the following repositories:
- arch-network/arch-network
- arch-network/book
- arch-network/arch-infrastructure
- arch-network/arch-k8s

## Slack Commands

- `/review generate` - Generate a new contribution report for all repositories
- `/review user [username]` - Get detailed contribution data for a specific GitHub user
- `/review lastweek` - Show the most recent contribution report
- `/review help` - Show help information

## Setup

### Prerequisites

- Node.js (v14 or higher)
- MongoDB database
- Slack workspace with admin permissions
- GitHub API token with repo scope

### Environment Variables

Copy `.env.example` to `.env` and fill in the required environment variables:

```
# Slack API Tokens
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-token

# MongoDB Connection
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/github-analyzer?retryWrites=true&w=majority

# GitHub API Token - needs repo scope
GITHUB_TOKEN=github_pat_your_personal_access_token

# Application Settings
PORT=3000
NODE_ENV=development

# Weekly Report Settings
ENABLE_WEEKLY_REPORTS=true
WEEKLY_REPORT_CRON=0 9 * * 1  # Monday at 9AM
WEEKLY_REPORT_CHANNEL=C12345678  # Slack channel ID
```

### Installation

1. Clone the repository:
```
git clone https://github.com/yourusername/github-contribution-analyzer.git
cd github-contribution-analyzer
```

2. Install dependencies:
```
npm install
```

3. Start the bot:
```
npm start
```

For development:
```
npm run dev
```

### Configuring Slack App

1. Create a new Slack app at https://api.slack.com/apps
2. Add the following bot token scopes:
   - `commands`
   - `chat:write`
   - `chat:write.public`
   - `users:read`
   - `users:read.email`
3. Enable Interactivity and add your bot URL + `/slack/events`
4. Create a slash command:
   - Command: `/review`
   - Request URL: `https://your-bot-url/slack/events`
   - Description: "Analyze GitHub contributions"
   - Usage hint: "generate | user username | lastweek | help"
5. Install the app to your workspace

## Deployment

The bot can be deployed to any platform that supports Node.js. Popular options include:

- Heroku
- AWS Elastic Beanstalk
- Google Cloud Run
- Digital Ocean
- Railway

## License

MIT 
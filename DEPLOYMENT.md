# GitHub Analyzer Deployment Guide

This document provides detailed instructions for deploying the GitHub Contribution Analyzer to Google Cloud Platform (GCP) using Cloud Run.

## Prerequisites

Before deploying, ensure you have:

1. [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed and configured
2. [Docker](https://docs.docker.com/get-docker/) installed and running
3. Access to the Google Cloud project with appropriate permissions
4. GCP Secrets configured for the following:
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `SLACK_APP_TOKEN`
   - `GITHUB_TOKEN`
   - `MONGODB_URI`
   - `ANTHROPIC_API_KEY`
   - `DEFAULT_CHANNEL`
   - `WEEKLY_REPORT_CHANNEL`

## Deployment Options

### Option 1: Using the Deployment Script

We provide a deployment script that handles building, pushing, and deploying the application:

```bash
./deploy-to-gcp.sh [VERSION_TAG]
```

If no version tag is provided, the script will generate one using the current timestamp.

### Option 2: Manual Deployment

If you prefer to deploy manually, follow these steps:

1. **Build the Docker image**:
   ```bash
   docker build -t gcr.io/archnetwork/github-analyzer:v1 .
   ```

2. **Push to Google Container Registry**:
   ```bash
   docker push gcr.io/archnetwork/github-analyzer:v1
   ```

3. **Deploy to Cloud Run**:
   ```bash
   gcloud run deploy github-analyzer \
     --image gcr.io/archnetwork/github-analyzer:v1 \
     --platform managed \
     --region us-east1 \
     --allow-unauthenticated \
     --set-env-vars=NODE_ENV=production,ENABLE_WEEKLY_REPORTS=true \
     --set-secrets=SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest,MONGODB_URI=MONGODB_URI:latest,GITHUB_TOKEN=GITHUB_TOKEN:latest,SLACK_SIGNING_SECRET=SLACK_SIGNING_SECRET:latest,SLACK_APP_TOKEN=SLACK_APP_TOKEN:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,DEFAULT_CHANNEL=DEFAULT_CHANNEL:latest,WEEKLY_REPORT_CHANNEL=WEEKLY_REPORT_CHANNEL:latest
   ```

## Performance Optimization

For optimal performance in Cloud Run, the following environment variables should be added:

```bash
MEMORY_OPTIMIZED=true
MAX_REPOS=3
MAX_BRANCH_PAGES=5
SKIP_DETAILED_CONTENT=true
SKIP_AI_ANALYSIS=true
CACHE_TTL=3600000
```

These settings are included automatically when using the deployment script.

## Monitoring the Deployment

After deployment, you can:

1. **View logs**:
   ```bash
   gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=github-analyzer" --limit=50
   ```

2. **Check the deployment status**:
   ```bash
   gcloud run services describe github-analyzer --region us-east1
   ```

## Troubleshooting

If you encounter issues:

1. Check if all required GCP Secrets are properly configured
2. Ensure the service has proper permissions to access other GCP services
3. Check the Docker image builds successfully locally before pushing
4. Verify memory settings in Cloud Run match expected workload

## Environment Variables Reference

The full list of supported environment variables is available in the `cloud-run-environment.txt` file. 
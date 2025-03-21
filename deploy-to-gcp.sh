#!/bin/bash
# Deployment script for GitHub Analyzer to Google Cloud Platform

# Stop on any error
set -e

# Configuration
PROJECT_ID="archnetwork"
SERVICE_NAME="github-analyzer"
REGION="us-east1"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# Read version from command line or use timestamp
if [ -z "$1" ]; then
  VERSION="v$(date +%Y%m%d%H%M)"
  echo "No version specified, using: $VERSION"
else
  VERSION="$1"
  echo "Using version: $VERSION"
fi

# Ensure we're logged in to gcloud
echo "Verifying gcloud authentication..."
gcloud auth print-access-token > /dev/null

# Ensure Docker is running
echo "Checking if Docker is running..."
if ! docker info > /dev/null 2>&1; then
  echo "Docker is not running. Please start Docker."
  exit 1
fi

# Load environment variables for optimization
echo "Setting up environment variables from cloud-run-environment.txt..."
if [ -f "cloud-run-environment.txt" ]; then
  # Extract non-commented environment variables
  ENV_VARS=$(grep -v '^#' cloud-run-environment.txt | grep -v '^$' | sed 's/^/--set-env-vars=/g' | paste -sd ',' -)
  echo "Environment variables loaded."
else
  echo "Warning: cloud-run-environment.txt not found. Using default optimization settings."
  ENV_VARS="--set-env-vars=MEMORY_OPTIMIZED=true,MAX_REPOS=3,MAX_BRANCH_PAGES=5,SKIP_DETAILED_CONTENT=true,SKIP_AI_ANALYSIS=true,CACHE_TTL=3600000"
fi

# Set current working directory to project root
cd "$(dirname "$0")"

# Build the Docker image
echo "Building Docker image: ${IMAGE_NAME}:${VERSION}..."
docker build -t "${IMAGE_NAME}:${VERSION}" .

# Push the image to Google Container Registry
echo "Pushing image to Google Container Registry..."
docker push "${IMAGE_NAME}:${VERSION}"

# Deploy to Cloud Run
echo "Deploying to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE_NAME}:${VERSION}" \
  --platform managed \
  --region "${REGION}" \
  --allow-unauthenticated \
  --set-env-vars="NODE_ENV=production,ENABLE_WEEKLY_REPORTS=true" \
  --set-secrets="SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest,MONGODB_URI=MONGODB_URI:latest,GITHUB_TOKEN=GITHUB_TOKEN:latest,SLACK_SIGNING_SECRET=SLACK_SIGNING_SECRET:latest,SLACK_APP_TOKEN=SLACK_APP_TOKEN:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,DEFAULT_CHANNEL=DEFAULT_CHANNEL:latest,WEEKLY_REPORT_CHANNEL=WEEKLY_REPORT_CHANNEL:latest" \
  ${ENV_VARS}

echo "Deployment complete! Service is available at:"
gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" --format="value(status.url)" 
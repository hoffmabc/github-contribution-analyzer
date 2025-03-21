FROM --platform=linux/amd64 node:16-slim

# Install curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application code
COPY . .

# Set environment variables
ENV NODE_ENV=production

# Make sure the app listens on the port provided by Cloud Run
# App is binding to port 3000 internally despite our settings
ENV PORT=3000

# Explicitly expose port 3000 for internal communication
EXPOSE 3000

# Create a non-root user and switch to it
RUN groupadd -r nodejs && useradd -r -g nodejs nodejs
RUN chown -R nodejs:nodejs /app
USER nodejs

# Add health check using the correct internal port
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Explicitly set the entrypoint and command with garbage collection enabled
CMD ["node", "--expose-gc", "src/index.js"]
FROM --platform=linux/amd64 node:16-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application code
COPY . .

# Set environment variables
ENV NODE_ENV=production

# Make sure the app listens on the port provided by Cloud Run
ENV PORT=8080

# Explicitly set the entrypoint and command
CMD ["node", "src/index.js"]
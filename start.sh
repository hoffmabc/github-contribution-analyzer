#!/bin/bash

# Check if MongoDB is running
echo "Checking if MongoDB is running..."
if ! pgrep -x "mongod" > /dev/null
then
    echo "MongoDB is not running. Please start MongoDB before running the bot."
    echo "You can start MongoDB with: brew services start mongodb-community"
    exit 1
fi

# Check if .env file exists
if [ ! -f .env ]; then
    echo "No .env file found. Creating from .env.example..."
    if [ -f .env.example ]; then
        cp .env.example .env
        echo ".env file created. Please edit it to set your Slack API credentials."
        exit 1
    else
        echo "No .env.example file found. Please create a .env file with your Slack API credentials."
        exit 1
    fi
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Start the bot
echo "Starting the Code Review Bot..."
npm start 
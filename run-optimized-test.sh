#!/bin/bash
# Run the test runner with optimization flags set

# Set optimization flags
export MEMORY_OPTIMIZED=true
export MAX_REPOS=1
export MAX_BRANCH_PAGES=5
export SKIP_DETAILED_CONTENT=true
export SKIP_AI_ANALYSIS=true
export CACHE_TTL=3600000

# Run the test with the specified command or default to 'generate'
COMMAND=${1:-generate}
ARGS=${@:2}

echo "Running test with command: $COMMAND $ARGS"
node test-runner.js $COMMAND $ARGS 
#!/bin/bash
# ================================================================================================
# Usage: Run the script from the ./dextrader/watcher-v2 folder
# needs execution permission: ./scripts/deploy.sh
# cmd: ./scripts/deploy.sh
# This script does the following
# 1. stops systemd service related to the application (dex-trader)
# 2. pulls the latest code from the git repository
# 3. builds the application
# 4. starts the systemd service again
# ================================================================================================

# Configuration
APP_NAME="universal-trader"


# 1. Stop services gracefully
echo "Stopping $APP_NAME services..."
sudo systemctl stop ${APP_NAME}.service 

# 2. Pull latest code
echo "Pulling latest code from git repository..."
git pull origin main

# 3. Build the application
cd ./watcher
echo "Bun app does not need to be built, skipping build step."

# 4. Start services
echo "Starting $APP_NAME services..."
sudo systemctl start ${APP_NAME}.service
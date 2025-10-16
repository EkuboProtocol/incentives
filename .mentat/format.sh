#!/bin/bash

# This script runs formatters and autofix linters before commits
# Currently configured: Prettier for code formatting
npm run format --if-present
npm run lint:fix --if-present
npm run fix --if-present

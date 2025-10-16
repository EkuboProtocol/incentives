#!/bin/bash

# Install npm dependencies
# Use npm ci for reproducible builds when package-lock.json exists
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

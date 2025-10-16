#!/bin/bash

# No formatters or linters are currently configured in this project
# This script will opportunistically run format/lint scripts if they are added in the future
npm run format --if-present
npm run lint:fix --if-present

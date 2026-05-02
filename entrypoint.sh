#!/bin/sh

echo "=== AirWaves Seller Backend ==="
echo "NODE_ENV=${NODE_ENV}"
echo "PORT=${PORT:-3000}"
echo "PUBLIC_URL=${PUBLIC_URL}"
echo "DATABASE_URL_PREFIX=$(echo "${DATABASE_URL}" | cut -c1-60)..."
echo "JWT_PRIVATE_KEY_LEN=${#JWT_PRIVATE_KEY}"
echo "JWT_PUBLIC_KEY_BASE64_LEN=${#JWT_PUBLIC_KEY_BASE64}"
echo "JWT_PUBLIC_KEY_ID=${JWT_PUBLIC_KEY_ID}"
echo "==============================="

node dist/server.js
EXIT_CODE=$?
echo "node exited with code $EXIT_CODE — sleeping 300s to expose logs"
sleep 300
exit $EXIT_CODE

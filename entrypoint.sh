#!/bin/sh

echo "=== AirWaves Seller Backend Starting ==="
echo "NODE_ENV=${NODE_ENV}"
echo "PORT=${PORT:-3000}"
echo "PUBLIC_URL=${PUBLIC_URL}"
echo "DATABASE_URL_PREFIX=$(echo "${DATABASE_URL}" | cut -c1-50)..."
echo "JWT_PRIVATE_KEY_LEN=${#JWT_PRIVATE_KEY}"
echo "JWT_PUBLIC_KEY_BASE64_LEN=${#JWT_PUBLIC_KEY_BASE64}"
echo "JWT_PUBLIC_KEY_ID=${JWT_PUBLIC_KEY_ID}"
echo "STRIPE_WEBHOOK_SECRET_LEN=${#STRIPE_WEBHOOK_SECRET}"
echo "RESEND_API_KEY_LEN=${#RESEND_API_KEY}"
echo "ADMIN_SECRET_LEN=${#ADMIN_SECRET}"
echo "======================================="

node dist/server.js &
NODE_PID=$!
echo "Node started with PID $NODE_PID"

# Wait for node to exit
wait $NODE_PID
EXIT_CODE=$?
echo "Node exited with code $EXIT_CODE"

if [ "$EXIT_CODE" != "0" ]; then
  echo "Server crashed! Serving diagnostic endpoint for 5 minutes..."
  # Start a minimal HTTP server to expose the error
  node -e "
const http = require('http');
const msg = JSON.stringify({
  error: 'Server crashed at startup',
  exitCode: $EXIT_CODE,
  env: {
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT,
    PUBLIC_URL: process.env.PUBLIC_URL,
    DATABASE_URL_PREFIX: (process.env.DATABASE_URL || '').substring(0,50),
    JWT_PRIVATE_KEY_LEN: (process.env.JWT_PRIVATE_KEY || '').length,
    JWT_PUBLIC_KEY_BASE64_LEN: (process.env.JWT_PUBLIC_KEY_BASE64 || '').length,
  }
});
const port = parseInt(process.env.PORT || '3000');
http.createServer((_, res) => {
  res.writeHead(503, {'Content-Type': 'application/json'});
  res.end(msg);
}).listen(port, '0.0.0.0', () => console.log('Diagnostic server on port ' + port));
setTimeout(() => process.exit($EXIT_CODE), 300000);
"
fi

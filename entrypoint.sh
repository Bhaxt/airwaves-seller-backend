#!/bin/sh
set -e

echo "=== AirWaves Seller Backend Starting ==="
echo "NODE_ENV=${NODE_ENV}"
echo "PORT=${PORT}"
echo "PUBLIC_URL=${PUBLIC_URL}"
echo "DATABASE_URL=${DATABASE_URL:0:40}..."
echo "JWT_PRIVATE_KEY length=${#JWT_PRIVATE_KEY}"
echo "JWT_PUBLIC_KEY_BASE64 length=${#JWT_PUBLIC_KEY_BASE64}"
echo "JWT_PUBLIC_KEY_ID=${JWT_PUBLIC_KEY_ID}"
echo "STRIPE_WEBHOOK_SECRET length=${#STRIPE_WEBHOOK_SECRET}"
echo "RESEND_API_KEY length=${#RESEND_API_KEY}"
echo "ADMIN_SECRET length=${#ADMIN_SECRET}"
echo "======================================="

exec node dist/server.js

FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY . .
RUN ./node_modules/.bin/tsc --version && ./node_modules/.bin/tsc

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json .
EXPOSE 3000
CMD ["node", "dist/server.js"]

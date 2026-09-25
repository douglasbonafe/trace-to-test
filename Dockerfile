FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Same gate as CI: unit tests, then replay of the approved dataset.
CMD ["sh", "-c", "npm test && npm run replay"]

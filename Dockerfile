FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENTRYPOINT ["node", "bin/awb.mjs", "mcp"]

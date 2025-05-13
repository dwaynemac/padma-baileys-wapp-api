# Base image with WebCrypto baked-in
FROM node:20-alpine

# 1. Create working dir
WORKDIR /app

# 2. Add deps first (leverages Docker layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# 3. Copy source
COPY . .

# 4. Expose API port
EXPOSE 8300

# 5. Run the server
CMD ["node", "src/index.js"]

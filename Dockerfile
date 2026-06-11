FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

USER node

EXPOSE 6754

CMD ["node", "server.js"]

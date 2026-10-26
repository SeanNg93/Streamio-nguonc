FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY src ./src
ENV PORT=7000
EXPOSE 7000
USER node
CMD ["node", "server.js"]

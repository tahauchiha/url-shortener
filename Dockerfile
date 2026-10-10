FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npx tsc
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
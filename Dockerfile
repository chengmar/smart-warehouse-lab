FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@10
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
COPY public ./public
ENV HOST=0.0.0.0
EXPOSE 3210
USER node
CMD ["node","src/server.js"]

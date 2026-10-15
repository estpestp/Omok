FROM node:22-alpine
WORKDIR /app
COPY server.js ./server.js
COPY index.html ./index.html
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]

FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV PORT=8788 DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 8788
CMD ["node", "server.js"]

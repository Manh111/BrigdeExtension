FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

RUN groupadd -r scorebridge && useradd -r -g scorebridge scorebridge
COPY . .
RUN chown -R scorebridge:scorebridge /app

USER scorebridge
EXPOSE 7478
CMD ["node", "server.js"]

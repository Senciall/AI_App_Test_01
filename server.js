// Server entry point — delegates to server/index.js
const server = require('./server/index.js');

if (require.main === module) {
  require('./server/embeddings').ensureEmbeddingModel().catch(() => {});
  server.startServer(server.PORT);
}

module.exports = server;

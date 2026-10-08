// Isolated UI preview without a WhatsApp client or data-writing handlers.
const express = require('express');
const path = require('node:path');
const app = express();
const server = require('node:http').createServer(app);
new (require('socket.io').Server)(server);
app.use(express.static(path.join(__dirname, '../public')));
server.listen(4173, '127.0.0.1', () => console.log('UI preview: http://127.0.0.1:4173'));

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// Mapping: socketId -> deviceType ('target' or 'monitor')
const sessions = new Map();

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    socket.on('register', (data) => {
        const { type, roomId } = data;
        socket.join(roomId);
        sessions.set(socket.id, { type, roomId });
        console.log(`Socket ${socket.id} registered as ${type} in room ${roomId}`);

        // Notify monitors if a target joined
        if (type === 'target') {
            socket.to(roomId).emit('target-status', { status: 'online', id: socket.id });
        }
    });

    // Signaling
    socket.on('signal', (data) => {
        // Envia para o destinatário específico ou para a sala (exceto para o remetente)
        socket.to(data.to).emit('signal', {
            from: socket.id,
            signal: data.signal
        });
    });

    // Remote Commands (Parent -> Target)
    socket.on('remote-command', (data) => {
        const { roomId, command } = data;
        socket.to(roomId).emit('remote-command', command);
    });

    // Heartbeat / Data sync (Location, Battery, etc.)
    socket.on('update-data', (data) => {
        const session = sessions.get(socket.id);
        if (session && session.type === 'target') {
            socket.to(session.roomId).emit('target-update', data);
        }
    });

    socket.on('disconnect', () => {
        const session = sessions.get(socket.id);
        if (session && session.type === 'target') {
            socket.to(session.roomId).emit('target-status', { status: 'offline', id: socket.id });
        }
        sessions.delete(socket.id);
        console.log('Disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Monitoring Server running on port ${PORT}`);
});

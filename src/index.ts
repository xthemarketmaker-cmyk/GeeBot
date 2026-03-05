import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import path from 'path';
import { initDb } from './db';
import db from './db';
import { generateChatResponse } from './ai';
import * as kickApi from './kick_api';
import crypto from 'crypto';

// Load environment variables
dotenv.config();

// Initializing Database
initDb();

const KICK_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq/+l1WnlRrGSolDMA+A8
6rAhMbQGmQ2SapVcGM3zq8ANXjnhDWocMqfWcTd95btDydITa10kDvHzw9WQOqp2
MZI7ZyrfzJuz5nhTPCiJwTwnEtWft7nV14BYRDHvlfqPUaZ+1KR4OCaO/wWIk/rQ
L/TjY0M70gse8rlBkbo2a8rKhu69RQTRsoaf4DVhDPEeSeI5jVrRDGAMGL3cGuyY
6CLKGdjVEM78g3JfYOvDU/RvfqD7L89TZ3iN94jrmWdGz34JNlEI5hqK8dd7C5EF
BEbZ5jgB8s8ReQV8H+MkuffjdAj3ajDDX3DOJMIut1lBrUVD1AaSrGCKHooWoL2e
twIDAQAB
-----END PUBLIC KEY-----`;

/**
 * Verifies the signature of a webhook request from Kick.com
 */
function verifyKickSignature(req: any): boolean {
    const signature = req.headers['kick-event-signature'];
    const messageId = req.headers['kick-event-message-id'];
    const timestamp = req.headers['kick-event-message-timestamp'];
    const rawBody = req.rawBody?.toString() || '';

    if (!signature || !messageId || !timestamp) {
        console.error('[Webhook] Missing security headers');
        return false;
    }

    try {
        const signData = `${messageId}.${timestamp}.${rawBody}`;
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(signData);

        return verifier.verify(KICK_PUBLIC_KEY, signature, 'base64');
    } catch (err) {
        console.error('[Webhook] Signature verification error:', err);
        return false;
    }
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: '*', // Allow overlays to connect from anywhere during dev
    }
});

// Middleware
app.use(cors());
app.use(express.json({
    verify: (req: any, res, buf) => {
        req.rawBody = buf;
    }
})); // For parsing application/json webhooks and capturing raw body for signature verification
app.use(express.static(path.join(__dirname, '..', 'public'))); // Serve dashboard and overlays

const PORT = process.env.PORT || 3000;

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`New client connected: ${socket.id}`);

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

// Basic health check route
app.get('/health', (req, res) => {
    res.json({ status: 'ok', bot: 'GeeBot Core Service' });
});

// OAuth Callback for linking streamer channels (Phase 2)
app.get('/auth/kick/callback', async (req, res) => {
    // This page serves as a bridge to get the PKCE verifier from browser sessionStorage
    res.send(`
        <html>
        <body style="background: #111; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh;">
            <div id="status-container" style="text-align: center; max-width: 500px; padding: 20px; border: 1px solid #333; border-radius: 10px; background: #1a1a1a;">
                <h2 id="main-status">Finalizing Connection...</h2>
                <p id="sub-status">Please wait while we sync Gee_Bot with your channel.</p>
                <div id="debug-info" style="margin-top: 20px; padding: 10px; font-size: 0.8rem; color: #888; font-family: monospace; text-align: left; background: #000; border-radius: 5px;">
                    <div>• Code Detected: <span id="debug-code">Checking...</span></div>
                    <div>• Verifier Detected: <span id="debug-verifier">Checking...</span></div>
                    <div>• Server Handshake: <span id="debug-handshake">Waiting...</span></div>
                </div>
            </div>
            <script>
                const urlParams = new URLSearchParams(window.location.search);
                const code = urlParams.get('code');
                const state = urlParams.get('state');
                const verifier = sessionStorage.getItem('kick_oauth_verifier');
                
                document.getElementById('debug-code').textContent = code ? 'YES' : 'MISSING';
                document.getElementById('debug-verifier').textContent = verifier ? 'YES' : 'MISSING';

                // Timeout after 30 seconds
                const timeout = setTimeout(() => {
                    document.getElementById('main-status').textContent = 'Hanging...';
                    document.getElementById('sub-status').textContent = 'The server is taking too long. Check your Railway logs for a "Step 1" message.';
                    document.getElementById('debug-handshake').textContent = 'TIMEOUT';
                }, 30000);

                if (!code || !verifier) {
                    clearTimeout(timeout);
                    document.getElementById('main-status').textContent = 'Missing Handshake Data';
                    document.getElementById('sub-status').textContent = 'The security token or authorization code is missing. Try clicking the link button again.';
                    return;
                }

                document.getElementById('debug-handshake').textContent = 'In Progress...';

                fetch('/api/auth/complete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code, verifier, state })
                })
                .then(r => r.json())
                .then(data => {
                    clearTimeout(timeout);
                    if (data.success) {
                        document.getElementById('debug-handshake').textContent = 'SUCCESS';
                        window.location.href = '/?linked=true';
                    } else {
                        document.getElementById('debug-handshake').textContent = 'FAILED';
                        document.getElementById('main-status').textContent = 'Server Error';
                        document.getElementById('sub-status').textContent = data.error;
                    }
                })
                .catch(err => {
                    clearTimeout(timeout);
                    document.getElementById('debug-handshake').textContent = 'NETWORK ERROR';
                    document.getElementById('main-status').textContent = 'Connection Error';
                    document.getElementById('sub-status').textContent = 'Could not reach the backend. Error: ' + err.message;
                });
            </script>
        </body>
        </html>
    `);
});

// Endpoint to exchange code for token and join channel
app.post('/api/auth/complete', async (req, res) => {
    const { code, verifier } = req.body;
    console.log('[OAuth Server] Starting token exchange...');

    try {
        // 1. Exchange code for token
        console.log('[OAuth Server] Step 1: Exchanging code...');
        const tokenResponse = await kickApi.exchangeCodeForToken(code, verifier);
        const accessToken = tokenResponse.access_token;
        console.log('[OAuth Server] Step 1 Success: Token acquired.');

        // 2. Identify the Streamer via the token
        console.log('[OAuth Server] Step 2: Fetching user info...');
        const userInfo = await kickApi.getAuthenticatedUser(accessToken);
        const channelId = userInfo.channel_id;
        const streamerName = userInfo.username;
        console.log(`[OAuth Server] Step 2 Success: Linked streamer ${streamerName} (${channelId})`);

        // 3. Store the token in the database (scoped per channel)
        console.log('[OAuth Server] Step 3: Saving settings...');
        const stmt = db.prepare('INSERT OR REPLACE INTO settings (channel_id, key, value) VALUES (?, ?, ?)');
        stmt.run(channelId.toString(), 'kick_user_token', accessToken);
        stmt.run(channelId.toString(), 'streamer_name', streamerName);

        // 4. Send a "HELLO" message to join the chat
        console.log('[OAuth Server] Step 4: Sending join message...');
        await kickApi.sendChatMessage(channelId.toString(), `[Gee_Bot] System Online! I have successfully connected to your channel, @${streamerName}. 🟢`);
        console.log('[OAuth Server] Step 4 Success: Message sent.');

        res.json({ success: true });
    } catch (err: any) {
        console.error('[OAuth Server] ERROR during finalization:', err.message);
        res.status(500).json({ success: false, error: err.message || 'Unknown server error' });
    }
});

// API Routes for Dashboard
app.get('/api/settings', (req, res) => {
    const rows = db.prepare('SELECT * FROM settings').all() as { key: string, value: string }[];
    const settingsMap = rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
    res.json(settingsMap);
});

app.post('/api/settings', (req, res) => {
    const settings = req.body;
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

    // Use a transaction for reliability
    const transaction = db.transaction((data) => {
        for (const [key, value] of Object.entries(data)) {
            upsert.run(key, value);
        }
    });

    transaction(settings);
    res.json({ status: 'success' });
});

app.post('/webhook/kick', async (req: any, res) => {
    try {
        // 1. Verify Signature
        if (!verifyKickSignature(req)) {
            console.warn('[Webhook] UNTRUSTED SOURCE: Signature verification failed.');
            return res.status(401).send('Unauthorized');
        }

        const payload = req.body;
        console.log('Received SECURE Webhook from Kick:', payload);

        // Return 200 OK immediately
        res.status(200).send('Webhook Received');

        // Example Payload parsing (based on generic structure, will conform to actual Kick docs):
        // We assume payload has an event type and data payload.
        if (payload.event === 'ChatMessageSent' || payload.type === 'message') {
            const sender = payload.data?.sender?.username || 'Unknown';
            const content = payload.data?.content || '';
            const senderId = payload.data?.sender?.id || '0';
            const channelId = payload.data?.channel_id || payload.channel_id;

            // 1. Save to Chat History context
            const insertChat = db.prepare('INSERT INTO chat_history (user_id, username, message) VALUES (?, ?, ?)');
            insertChat.run(senderId, sender, content);

            // 2. Broadcast raw message to Frontend overlay via WebSockets!
            io.emit('chatMessage', { sender, content });

            // 3. AI Module Trigger
            // If message mentions @GeeBot or starts with "GeeBot", respond
            if (content.toLowerCase().includes('@geebot') || content.toLowerCase().includes('geebot')) {
                const aiResponse = await generateChatResponse(sender, content);
                console.log(`[GeeBot AI Replying]: ${aiResponse}`);

                // Use the Official Kick API to send response back to the chat room
                try {
                    await kickApi.sendChatMessage(channelId.toString(), aiResponse);
                } catch (err) {
                    console.error('Failed to send official chat response:', err);
                }

                io.emit('chatMessage', { sender: 'Gee_Bot', content: aiResponse }); // Broadcast bot message to overlay too
            }
        }
    } catch (error) {
        console.error('Webhook processing error:', error);
    }
});

// Start the server
httpServer.listen(PORT, () => {
    console.log(`GeeBot Core Service running on port ${PORT}`);
    console.log(`WebSocket Server listening on port ${PORT}`);
});

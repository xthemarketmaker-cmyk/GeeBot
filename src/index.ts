import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import path from 'path';
import { initDb } from './db';
import db from './db';
import { generateChatResponse } from './ai';
import { sendChatMessage } from './kick_api';

// Load environment variables
dotenv.config();

// Initialize Database
initDb();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: '*', // Allow overlays to connect from anywhere during dev
    }
});

// Middleware
app.use(cors());
app.use(express.json()); // For parsing application/json webhooks
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
            <div id="status-container" style="text-align: center;">
                <h2>Finalizing Connection...</h2>
                <p>Please wait while we sync Gee_Bot with your channel.</p>
                <div id="debug-info" style="margin-top: 20px; font-size: 0.8rem; color: #666; font-family: monospace;"></div>
            </div>
            <script>
                const urlParams = new URLSearchParams(window.location.search);
                const code = urlParams.get('code');
                const state = urlParams.get('state');
                const verifier = sessionStorage.getItem('kick_oauth_verifier');
                const debugDiv = document.getElementById('debug-info');

                console.log('[GeeBot OAuth Bridge] Code:', !!code, 'State:', !!state, 'Verifier:', !!verifier);
                
                if (!code || !verifier) {
                    let errorMsg = 'Error: Missing Auth Data. ';
                    if (!code) errorMsg += 'Missing "code" in URL. ';
                    if (!verifier) errorMsg += 'Missing "verifier" in sessionStorage (Origin mismatch?). ';
                    
                    document.getElementById('status-container').innerHTML = \`
                        <h2 style="color: #ff5555;">Linking Failed</h2>
                        <p>\${errorMsg}</p>
                        <p style="font-size: 0.9rem;">Make sure you are accessing the dashboard on the SAME URL as your redirect portal.</p>
                        <button onclick="window.location.href='/'" style="background: #53fc18; color: black; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">Back to Dashboard</button>
                    \`;
                    return;
                }

                fetch('/api/auth/complete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code, verifier, state })
                })
                .then(r => r.json())
                .then(data => {
                    if (data.success) {
                        window.location.href = '/?linked=true';
                    } else {
                        alert('Connection failed on server: ' + data.error);
                    }
                })
                .catch(err => {
                    alert('Network error finalizing connection: ' + err.message);
                });
            </script>
        </body>
        </html>
    `);
});

// Endpoint to exchange code for token and join channel
app.post('/api/auth/complete', async (req, res) => {
    const { code, verifier } = req.body;
    console.log('[OAuth Server] Starting token exchange for code:', code?.substring(0, 5) + '...');

    try {
        // 1. Exchange code for token
        console.log('[OAuth Server] Step 1: Exchanging code...');
        const tokenResponse = await (await import('./kick_api')).exchangeCodeForToken(code, verifier);
        const accessToken = tokenResponse.access_token;
        console.log('[OAuth Server] Step 1 Success: Token acquired.');

        // 2. Identify the Streamer via the token
        console.log('[OAuth Server] Step 2: Fetching user info...');
        const userInfo = await (await import('./kick_api')).getAuthenticatedUser(accessToken);
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
        await (await import('./kick_api')).sendChatMessage(channelId.toString(), `[Gee_Bot] System Online! I have successfully connected to your channel, @${streamerName}. 🟢`);
        console.log('[OAuth Server] Step 4 Success: Message sent.');

        res.json({ success: true });
    } catch (err: any) {
        console.error('[OAuth Server] ERROR during finalization:', err.message);
        res.status(500).json({ success: false, error: err.message });
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

// Official Kick API Webhook Endpoint Placeholder
app.post('/webhook/kick', async (req, res) => {
    try {
        // TODO: Verify signature from Kick API header: x-kick-signature
        const payload = req.body;

        console.log('Received Webhook from Kick:', payload);

        // Return 200 OK immediately so Kick knows we received it
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
                if (channelId) {
                    // Save bot response to DB for context immediately
                    const insertBotMsg = db.prepare('INSERT INTO chat_history (channel_id, user_id, username, message) VALUES (?, ?, ?, ?)');
                    insertBotMsg.run(channelId.toString(), '0', 'Gee_Bot', aiResponse);

                    try {
                        await sendChatMessage(channelId.toString(), aiResponse);
                    } catch (err) {
                        console.error('Failed to send official chat response (expected if channel_id is simulated):', err);
                    }
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

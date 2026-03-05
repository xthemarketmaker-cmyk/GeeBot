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
import Pusher from 'pusher-js';

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

// The Kick slug of the bot account itself (e.g. kick.com/gee-bot).
// When this account does the OAuth flow, we store its token as the global bot token.
const BOT_KICK_SLUG = (process.env.BOT_KICK_SLUG || 'gee-bot').toLowerCase();

/**
 * Retrieves the best available token for sending chat messages.
 * Priority: (1) bot account's own User Token, (2) the linked channel's streamer token.
 */
function getSendToken(channelId: string): string | undefined {
    const botTokenRow = db.prepare('SELECT value FROM settings WHERE channel_id = ? AND key = ?')
        .get('__bot__', 'bot_user_token') as { value: string } | undefined;
    if (botTokenRow?.value) return botTokenRow.value;

    const channelTokenRow = db.prepare('SELECT value FROM settings WHERE channel_id = ? AND key = ?')
        .get(channelId, 'kick_user_token') as { value: string } | undefined;
    return channelTokenRow?.value;
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`New client connected: ${socket.id}`);

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

// --- PUSHER WEBSOCKET IMPLEMENTATION (KICK CHAT READER) ---
// Kick's official HTTP Webhooks for chat are currently broken/unreliable.
// We instead connect directly to their Pusher WebSocket cluster to read chat live.
const activePusherSubs = new Map<string, any>();
const KICK_PUSHER_APP_KEY = '32cbd69e4b950bf97679'; // Kick's public Pusher key
const KICK_PUSHER_CLUSTER = 'us2';

function subscribeToKickChat(chatroomId: string, channelId: string, streamerName: string) {
    if (activePusherSubs.has(chatroomId)) {
        console.log(`[Pusher] Already listening to chatroom ${chatroomId} (@${streamerName})`);
        return;
    }

    console.log(`[Pusher] Connecting to Kick WebSocket for @${streamerName} (Room ID: ${chatroomId})...`);

    // Initialize Pusher Client
    const pusher = new Pusher(KICK_PUSHER_APP_KEY, {
        cluster: KICK_PUSHER_CLUSTER,
        wsHost: 'ws-us2.pusher.com',
        wsPort: 443,
        wssPort: 443,
        forceTLS: true,
        enabledTransports: ['ws', 'wss']
    });

    // The channel name format for a Kick chatroom
    const pusherChannelName = `chatrooms.${chatroomId}.v2`;
    const channel = pusher.subscribe(pusherChannelName);

    // Bind to the specific event Kick uses for new messages
    channel.bind('App\\Events\\ChatMessageEvent', async (data: any) => {
        const sender = data.sender?.username || 'Unknown';
        const content = data.content || '';
        const senderId = data.sender?.id?.toString() || '0';

        // Ignore messages sent by our own bot to prevent loops
        if (sender.toLowerCase() === BOT_KICK_SLUG) return;

        console.log(`[Pusher Chat] @${streamerName} | ${sender}: ${content}`);

        // 1. Save to Chat History
        const insertChat = db.prepare('INSERT INTO chat_history (channel_id, user_id, username, message) VALUES (?, ?, ?, ?)');
        insertChat.run(channelId, senderId, sender, content);

        // 2. Broadcast raw message to Frontend overlay via WebSockets
        io.emit('chatMessage', { sender, content });

        // 3. AI trigger — respond if message mentions @GeeBot or "geebot"
        if (content.toLowerCase().includes('@geebot') || content.toLowerCase().includes('geebot')) {
            const aiResponse = await generateChatResponse(sender, content);
            console.log(`[GeeBot AI Replying]: ${aiResponse}`);

            try {
                const sendToken = getSendToken(channelId);
                await kickApi.sendChatMessage(channelId, aiResponse, sendToken);
            } catch (err) {
                console.error('Failed to send official chat response:', err);
            }

            // Also emit the bot's response to the overlay
            io.emit('chatMessage', { sender: 'Gee_Bot', content: aiResponse });
        }
    });

    pusher.connection.bind('connected', () => {
        console.log(`[Pusher] Connected successfully to @${streamerName}'s chat!`);
    });

    activePusherSubs.set(chatroomId, pusher);
}
// ------------------------------------------------------------

// Basic health check route
app.get('/health', (req, res) => {
    res.json({ status: 'ok', bot: 'GeeBot Core Service' });
});

// OAuth Callback for linking streamer channels (Phase 2)
app.get('/auth/kick/callback', async (req, res) => {
    // This page serves as a bridge to get the PKCE verifier from browser sessionStorage
    res.setHeader('Content-Type', 'text/html');
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
                <div style="margin-top: 20px;">
                    <button onclick="window.location.href='/'" style="background: #333; color: #888; border: none; padding: 5px 10px; border-radius: 5px; cursor: pointer; font-size: 0.7rem;">Cancel & Return</button>
                </div>
            </div>
            <script>
                window.onload = function() {
                    try {
                        const urlParams = new URLSearchParams(window.location.search);
                        const code = urlParams.get('code');
                        const state = urlParams.get('state');
                        const verifier = sessionStorage.getItem('kick_oauth_verifier');
                        
                        document.getElementById('debug-code').textContent = code ? 'YES' : 'MISSING';
                        document.getElementById('debug-verifier').textContent = verifier ? 'YES' : 'MISSING';

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
                            document.getElementById('sub-status').textContent = 'Could not reach the backend: ' + err.message;
                        });
                    } catch (e) {
                        alert('Script Error: ' + e.message);
                        document.getElementById('main-status').textContent = 'Script Error';
                        document.getElementById('sub-status').textContent = e.message;
                    }
                };
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

        // 2. Identify the user via the token
        console.log('[OAuth Server] Step 2: Fetching user info...');
        const userInfo = await kickApi.getAuthenticatedUser(accessToken);
        const channelId = userInfo.channel_id;
        const streamerName = userInfo.username;
        console.log(`[OAuth Server] Step 2 Success: Linked user ${streamerName} (channel_id: ${channelId})`);

        const stmt = db.prepare('INSERT OR REPLACE INTO settings (channel_id, key, value) VALUES (?, ?, ?)');

        // 3a. If the bot account (gee-bot) itself is doing OAuth, store as the global bot token
        if (streamerName.toLowerCase() === BOT_KICK_SLUG) {
            console.log('[OAuth Server] Step 3: Detected BOT account — storing global bot token...');
            stmt.run('__bot__', 'bot_user_token', accessToken);
            stmt.run('__bot__', 'bot_broadcaster_id', channelId.toString());
            console.log('[OAuth Server] Bot account linked successfully! GeeBot can now send messages.');
            return res.json({ success: true, isBotAccount: true });
        }

        // 3b. Regular streamer linking their channel
        console.log('[OAuth Server] Step 3: Saving streamer settings...');
        stmt.run(channelId.toString(), 'kick_user_token', accessToken);
        stmt.run(channelId.toString(), 'streamer_name', streamerName);

        // Save the chatroom_id if we got it, so we can reconnect Pusher on server restart
        if (userInfo.chatroom_id) {
            stmt.run(channelId.toString(), 'chatroom_id', userInfo.chatroom_id.toString());
            // Instantly subscribe the bot to this channel's live chat via Pusher WebSocket
            subscribeToKickChat(userInfo.chatroom_id.toString(), channelId.toString(), streamerName);
        } else {
            console.warn(`[OAuth Server] Warning: Could not extract chatroom_id for ${streamerName}. Live chat reading will fail.`);
        }

        // 4. Send welcome message — do NOT let this block or fail the auth flow
        console.log('[OAuth Server] Step 4: Sending join message...');
        const sendToken = getSendToken(channelId.toString()) || accessToken;
        kickApi.sendChatMessage(channelId.toString(), `[Gee_Bot] System Online! I have successfully connected to your channel, @${streamerName}. 🟢`, sendToken)
            .then(() => console.log('[OAuth Server] Step 4 Success: Join message sent.'))
            .catch((err: any) => console.warn(`[OAuth Server] Step 4 Warning: Chat message failed (${err.message}) — channel is still linked.`));

        // Return success immediately — the channel IS linked even if the welcome message fails
        res.json({ success: true, streamer: streamerName, channelId: channelId.toString() });

    } catch (err: any) {
        console.error('[OAuth Server] ERROR during finalization:', err.message);
        res.status(500).json({ success: false, error: err.message || 'Unknown server error' });
    }
});

// Diagnostic endpoint — shows what tokens are stored and tests a chat send
app.get('/api/debug', async (req, res) => {
    const botToken = db.prepare('SELECT value FROM settings WHERE channel_id = ? AND key = ?')
        .get('__bot__', 'bot_user_token') as { value: string } | undefined;
    const botChannelId = db.prepare('SELECT value FROM settings WHERE channel_id = ? AND key = ?')
        .get('__bot__', 'bot_broadcaster_id') as { value: string } | undefined;
    const linkedChannels = db.prepare("SELECT channel_id, key, value FROM settings WHERE channel_id != '__bot__' AND key = 'streamer_name'")
        .all() as { channel_id: string, key: string, value: string }[];

    // Attempt a test send if bot token + broadcaster id are present
    let chatTestResult = 'skipped — no bot token stored yet';
    if (botToken?.value && botChannelId?.value) {
        try {
            await kickApi.sendChatMessage(botChannelId.value, '[GeeBot] 🟢 Diagnostic test message.', botToken.value);
            chatTestResult = 'SUCCESS';
        } catch (err: any) {
            chatTestResult = `FAILED: ${err.message}`;
        }
    }

    res.json({
        botTokenStored: !!botToken?.value,
        botTokenPrefix: botToken?.value ? botToken.value.substring(0, 10) + '...' : null,
        botBroadcasterId: botChannelId?.value || null,
        linkedStreamers: linkedChannels.map(r => ({ channelId: r.channel_id, name: r.value })),
        chatTestResult
    });
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

        // Kick's official webhook event type for chat messages is 'chat.message.sent'
        if (payload.event === 'chat.message.sent') {
            const sender = payload.data?.sender?.username || 'Unknown';
            const content = payload.data?.content || '';
            const senderId = payload.data?.sender?.user_id?.toString() || '0';
            // broadcaster.user_id is the numeric ID of the channel this message came from
            const channelId = payload.data?.broadcaster?.user_id?.toString() || '';

            // 1. Save to Chat History for AI context
            const insertChat = db.prepare('INSERT INTO chat_history (channel_id, user_id, username, message) VALUES (?, ?, ?, ?)');
            insertChat.run(channelId, senderId, sender, content);

            // 2. Broadcast raw message to Frontend overlay via WebSockets
            io.emit('chatMessage', { sender, content });

            // 3. AI trigger — respond if message mentions @GeeBot or "geebot"
            if (content.toLowerCase().includes('@geebot') || content.toLowerCase().includes('geebot')) {
                const aiResponse = await generateChatResponse(sender, content);
                console.log(`[GeeBot AI Replying]: ${aiResponse}`);

                try {
                    const sendToken = getSendToken(channelId);
                    await kickApi.sendChatMessage(channelId, aiResponse, sendToken);
                } catch (err) {
                    console.error('Failed to send official chat response:', err);
                }

                io.emit('chatMessage', { sender: 'Gee_Bot', content: aiResponse });
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

    // Auto-reconnect Pusher to all previously linked channels
    const linkedChannels = db.prepare("SELECT channel_id, value FROM settings WHERE key = 'streamer_name' AND channel_id != '__bot__'").all() as { channel_id: string, value: string }[];
    for (const channel of linkedChannels) {
        const chatroomIdRow = db.prepare('SELECT value FROM settings WHERE channel_id = ? AND key = ?').get(channel.channel_id, 'chatroom_id') as { value: string } | undefined;
        if (chatroomIdRow?.value) {
            subscribeToKickChat(chatroomIdRow.value, channel.channel_id, channel.value);
        }
    }
});

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
import ws from 'ws';

// Assign WebSocket for Node.js compatibility since pusher-js is a browser-first library
(Pusher as any).Runtime.createWebSocket = (url: string) => new ws(url);

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
 * Sends a chat message, automatically handling token refresh if the current token is expired.
 * Priority: (1) bot account's own User Token, (2) the linked channel's streamer token.
 */
async function sendChatMessageWithRetry(channelId: string, message: string) {
    const botTokenRow = db.prepare('SELECT key, value FROM settings WHERE channel_id = ? AND key IN ("bot_user_token", "bot_refresh_token")').all('__bot__') as any[];
    const botTokens = botTokenRow.reduce((acc: any, row: any) => ({ ...acc, [row.key]: row.value }), {});

    let tokenContext = '__bot__';
    let token = botTokens.bot_user_token;
    let refreshToken = botTokens.bot_refresh_token;

    if (!token) {
        const channelTokenRow = db.prepare('SELECT key, value FROM settings WHERE channel_id = ? AND key IN ("kick_user_token", "kick_refresh_token")').all(channelId) as any[];
        const channelTokens = channelTokenRow.reduce((acc: any, row: any) => ({ ...acc, [row.key]: row.value }), {});
        token = channelTokens.kick_user_token;
        refreshToken = channelTokens.kick_refresh_token;
        tokenContext = channelId;
    }

    if (!token) {
        console.error(`[Chat] Cannot send message to ${channelId}: No access token found.`);
        return;
    }

    try {
        await kickApi.sendChatMessage(channelId, message, token);
    } catch (err: any) {
        if (err.message && err.message.includes('401') && refreshToken) {
            console.log(`[Chat] Token expired for context ${tokenContext}. Attempting refresh...`);
            try {
                const refreshed = await kickApi.refreshUserToken(refreshToken);
                const tokenKey = tokenContext === '__bot__' ? 'bot_user_token' : 'kick_user_token';
                const refreshKey = tokenContext === '__bot__' ? 'bot_refresh_token' : 'kick_refresh_token';

                db.prepare('INSERT OR REPLACE INTO settings (channel_id, key, value) VALUES (?, ?, ?)').run(tokenContext, tokenKey, refreshed.access_token);
                if (refreshed.refresh_token) {
                    db.prepare('INSERT OR REPLACE INTO settings (channel_id, key, value) VALUES (?, ?, ?)').run(tokenContext, refreshKey, refreshed.refresh_token);
                }

                await kickApi.sendChatMessage(channelId, message, refreshed.access_token);
                console.log(`[Chat] Message sent successfully after token refresh.`);
            } catch (refreshErr: any) {
                console.error(`[Chat] Token refresh failed for ${tokenContext}: ${refreshErr.message}`);
                throw refreshErr;
            }
        } else {
            console.error('[Chat] Failed to send message:', err.message);
            throw err;
        }
    }
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

    pusher.connection.bind('state_change', (states: any) => {
        console.log(`[Pusher Connection] @${streamerName} State: ${states.previous} -> ${states.current}`);
    });

    pusher.connection.bind('error', (err: any) => {
        console.error(`[Pusher Connection] @${streamerName} ERROR:`, err);
    });

    // Monitor connection every 30 seconds
    setInterval(() => {
        console.log(`[Pusher Monitor] @${streamerName} is currently: ${pusher.connection.state}`);
    }, 30000);

    // The channel name format for a Kick chatroom
    const channelName = `chatrooms.${chatroomId}.v2`;
    console.log(`[Pusher] Subscribing to ${channelName} for streamer ${streamerName}`);
    const channel = pusher.subscribe(channelName);

    // Bind to the specific event Kick uses for new messages
    channel.bind('App\\Events\\ChatMessageEvent', async (data: any) => {
        console.log(`[Pusher Debug] Incoming event on ${channelName}:`, JSON.stringify(data).substring(0, 100));
        const senderData = data.sender || {};
        const sender = senderData.username || senderData.slug || 'Unknown';
        const content = data.content || '';
        const senderId = (senderData.id || '0').toString();

        console.log(`[Pusher Chat] RAW EVENT: @${streamerName} | ${sender}: ${content} (ID: ${senderId})`);

        // Ignore messages sent by our own bot to prevent loops
        const normalizedSender = sender.toLowerCase().trim();
        const normalizedBot = BOT_KICK_SLUG.toLowerCase().trim();

        if (normalizedSender === normalizedBot || normalizedSender === 'geebot') {
            console.log(`[Pusher] Ignoring self-message from ${sender}`);
            return;
        }

        // --- 1. Save to Chat History ---
        const insertChat = db.prepare('INSERT INTO chat_history (channel_id, user_id, username, message) VALUES (?, ?, ?, ?)');
        insertChat.run(channelId, senderId, sender, content);

        // --- 2. Broadcast to Dashboard/Overlay ---
        io.emit('chatMessage', { sender, content });

        // --- 3. AI Trigger Logic ---
        const settingsRows = db.prepare('SELECT key, value FROM settings WHERE channel_id = ?').all(channelId) as any[];
        const channelSettings = settingsRows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {} as any);

        const probability = channelSettings.ai_probability || 'mentions';
        const personality = channelSettings.ai_personality || "You are GeeBot, the official and highly intelligent AI chat bot for this Kick channel. You help moderate the chat, answer questions, and keep the stream entertaining.";

        const lowerContent = content.toLowerCase();
        // Trigger only on the bot's name, not the streamer's
        const botMentions = ['@geebot', 'geebot'];
        const isMentioned = botMentions.some(m => lowerContent.includes(m));

        let shouldRespond = false;
        if (probability === 'everywhere') {
            shouldRespond = true;
        } else if (probability === 'random') {
            shouldRespond = Math.random() < 0.2 || isMentioned;
        } else {
            // Default: 'mentions'
            shouldRespond = isMentioned;
        }

        if (shouldRespond) {
            console.log(`[AI] Generating response for @${streamerName} (Trigger: ${probability}, Mentioned: ${isMentioned})...`);
            try {
                // Get recent context
                const history = db.prepare('SELECT username, message FROM chat_history WHERE channel_id = ? ORDER BY id DESC LIMIT 10').all(channelId) as any[];
                const context = history.reverse().map(h => `${h.username}: ${h.message}`).join('\n');

                const aiReply = await generateChatResponse(content, context, personality);
                console.log(`[AI] Reply generated: "${aiReply.substring(0, 50)}..."`);

                // Send to Kick
                await sendChatMessageWithRetry(channelId, aiReply);
                console.log(`[AI] Response sent to @${streamerName}`);

                // Also emit the bot's response to the overlay
                io.emit('chatMessage', { sender: 'Gee_Bot', content: aiReply });
            } catch (aiErr) {
                console.error('[AI Error]', aiErr);
            }
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
                            body: JSON.stringify({ code, verifier, state, redirectUri: window.location.origin + '/auth/kick/callback' })
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
    const { code, verifier, redirectUri } = req.body;
    console.log('[OAuth Server] Starting token exchange...');

    try {
        // 1. Exchange code for token
        console.log('[OAuth Server] Step 1: Exchanging code...');
        const tokenResponse = await kickApi.exchangeCodeForToken(code, verifier, redirectUri);
        const accessToken = tokenResponse.access_token;
        const refreshToken = tokenResponse.refresh_token;
        console.log('[OAuth Server] Step 1 Success: Token acquired.');

        // 2. Identify the user via the token
        console.log('[OAuth Server] Step 2: Fetching user info...');
        const userInfo = await kickApi.getAuthenticatedUser(accessToken);
        const channelId = userInfo.channel_id;
        const streamerName = userInfo.username;
        console.log(`[OAuth Server] Step 2 Success: Linked user ${streamerName} (channel_id: ${channelId})`);

        const stmt = db.prepare('INSERT OR REPLACE INTO settings (channel_id, key, value) VALUES (?, ?, ?)');

        // Regular streamer linking their channel
        console.log('[OAuth Server] Save: Saving streamer settings...');
        stmt.run(channelId.toString(), 'kick_user_token', accessToken);
        if (refreshToken) stmt.run(channelId.toString(), 'kick_refresh_token', refreshToken);
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
        sendChatMessageWithRetry(channelId.toString(), `[Gee_Bot] System Online! I have successfully connected to your channel, @${streamerName}. 🟢`)
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
    const linkedChannels = db.prepare("SELECT channel_id, key, value FROM settings WHERE key = 'streamer_name'")
        .all() as { channel_id: string, key: string, value: string }[];

    // Attempt a test send if we have at least one channel linked
    let chatTestResult = 'skipped — no channels linked';
    if (linkedChannels.length > 0) {
        const testChannel = linkedChannels[0];
        try {
            await sendChatMessageWithRetry(testChannel.channel_id, '[GeeBot] 🟢 Diagnostic test message.');
            chatTestResult = `SUCCESS sent to ${testChannel.value}`;
        } catch (err: any) {
            chatTestResult = `FAILED on ${testChannel.value}: ${err.message}`;
        }
    }

    res.json({
        linkedStreamers: linkedChannels.map(r => ({ channelId: r.channel_id, name: r.value })),
        chatTestResult
    });
});

// 5. Settings API
app.get('/api/settings', (req, res) => {
    // For now, get the first available channel or a specific one if provided
    const channelId = req.query.channel_id?.toString() || '__bot__';
    const settings = db.prepare('SELECT key, value FROM settings WHERE channel_id = ?').all(channelId);
    const settingsObj = settings.reduce((acc: any, s: any) => {
        acc[s.key] = s.value;
        return acc;
    }, {});
    res.json(settingsObj);
});

app.post('/api/settings', (req, res) => {
    const { channel_id, ...settings } = req.body;
    const targetChannel = channel_id || '__bot__';

    const upsert = db.prepare('INSERT OR REPLACE INTO settings (channel_id, key, value) VALUES (?, ?, ?)');

    const transaction = db.transaction((data) => {
        for (const [key, value] of Object.entries(data)) {
            upsert.run(targetChannel, key, value);
        }
    });

    transaction(settings);
    res.json({ success: true });
});

app.get('/api/channels/linked', (req, res) => {
    const channels = db.prepare("SELECT channel_id, value as channel_name FROM settings WHERE key = 'streamer_name'").all();
    res.json(channels);
});

// Note: We use Pusher WebSockets instead of webhooks for chat events 
// because Kick's official webhooks are currently unreliable.
app.post('/webhook/kick', async (req: any, res) => {
    res.status(200).send('Webhook Received (Ignored - Using Pusher)');
});

// --- 6. BACKGROUND TIMER SYSTEM ---
function startTimerLoop() {
    console.log('[Timer System] Starting background loop...');
    setInterval(async () => {
        const now = new Date();
        const activeTimers = db.prepare('SELECT * FROM timers WHERE is_enabled = 1').all() as any[];

        for (const timer of activeTimers) {
            const lastRun = new Date(timer.last_run);
            const diffMs = now.getTime() - lastRun.getTime();
            const diffMin = diffMs / (1000 * 60);

            if (diffMin >= timer.interval_minutes) {
                console.log(`[Timer System] Executing timer "${timer.name}" for channel ${timer.channel_id}`);
                try {
                    await sendChatMessageWithRetry(timer.channel_id, timer.message);
                    db.prepare('UPDATE timers SET last_run = CURRENT_TIMESTAMP WHERE id = ?').run(timer.id);
                    console.log(`[Timer System] Message sent: ${timer.message.substring(0, 30)}...`);
                } catch (err) {
                    console.error(`[Timer System] Failed for "${timer.name}":`, err);
                }
            }
        }
    }, 60000); // Check every minute
}

// Start existing timers
startTimerLoop();

// Subscribe to existing channels on startup
const subscribeToExisting = () => {
    const channels = db.prepare("SELECT channel_id, value as chatroom_id FROM settings WHERE key = 'chatroom_id'").all() as any[];
    console.log(`[Startup] Found ${channels.length} channels to subscribe to.`);
    channels.forEach(ch => {
        // Find channel_name
        const nameRow = db.prepare("SELECT value FROM settings WHERE channel_id = ? AND key = 'channel_name'").get(ch.channel_id) as any;
        const streamerName = nameRow?.value || 'Streamer';
        subscribeToKickChat(ch.chatroom_id, ch.channel_id, streamerName);
    });
};
subscribeToExisting();

// Start Server
httpServer.listen(PORT, () => {
    console.log(`GeeBot Backend is running on port ${PORT}`);
    console.log(`WebSocket Server listening on port ${PORT}`);
});

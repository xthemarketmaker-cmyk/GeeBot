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
import { startTrivia, checkTriviaAnswer } from './games';
import { handleCommand, handleActivity } from './commands';
import { generateSpeechBase64 } from './tts';

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

/**
 * Determines the base URL for the application, useful for callbacks.
 */
function getAppBaseUrl(): string {
    if (process.env.NODE_ENV === 'production' && process.env.VERCEL_URL) {
        return `https://${process.env.VERCEL_URL}`;
    }
    return `http://localhost:${process.env.PORT || 3000}`; // Fallback to localhost during dev
}

// In-Memory state for live Polls per channel
const activePolls = new Map<string, { question: string, options: string[], votes: number[], total: number, votedUsers: Set<string> }>();

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
        const senderData = data.sender || {};
        const sender = senderData.username || senderData.slug || 'Unknown';
        const content = data.content || '';
        const senderId = (senderData.id || '0').toString();

        console.log(`[Pusher Chat] RAW EVENT: @${streamerName} | ${sender}: ${content} (ID: ${senderId})`);

        // 0. Check if bot is even enabled for this channel
        const botEnabledRow = db.prepare("SELECT value FROM settings WHERE channel_id = ? AND key = 'bot_enabled'").get(channelId) as { value: string } | undefined;
        if (botEnabledRow?.value === 'false') {
            console.log(`[Pusher] Bot is DISABLED for channel ${channelId}. Ignoring message.`);
            return;
        }

        // Ignore messages sent by our own bot to prevent loops
        const cleanSender = sender.replace(/^@/, '');
        const normalizedSender = cleanSender.toLowerCase().replace(/_/g, '-');
        const normalizedBot = BOT_KICK_SLUG.toLowerCase().replace(/_/g, '-');

        if (normalizedSender === normalizedBot || normalizedSender === 'gee-bot' || normalizedSender === 'geebot' || normalizedSender === 'gee_bot') {
            console.log(`[Pusher] Ignoring self-message from ${sender}`);
            return;
        }

        // 1. Save to Chat History
        const insertChat = db.prepare('INSERT INTO chat_history (channel_id, user_id, username, message) VALUES (?, ?, ?, ?)');
        insertChat.run(channelId, senderId, sender, content);

        // 2. Broadcast raw message to Frontend overlay via WebSockets
        io.emit('chatMessage', { sender, content });

        // 3. AI trigger mechanism
        const lowerContent = content.toLowerCase();
        const isMentioned = lowerContent.includes('@geebot') ||
            lowerContent.includes('geebot') ||
            lowerContent.includes('@gee_bot') ||
            lowerContent.includes('gee_bot') ||
            lowerContent.includes('gee-bot');

        // Fetch AI settings
        // Fetch AI settings (needed for both game and AI logic)
        const aiEnabledRow = db.prepare("SELECT value FROM settings WHERE channel_id = ? AND key = 'ai_enabled'").get(channelId) as { value: string } | undefined;
        const aiProbRow = db.prepare("SELECT value FROM settings WHERE channel_id = ? AND key = 'ai_probability'").get(channelId) as { value: string } | undefined;
        const aiMode = aiProbRow?.value || 'mentions';

        let shouldTrigger = false;

        // 3. GAME ENGINE: Check for trivia answers or commands
        const sendToken = getSendToken(channelId);
        const gamesEnabled = db.prepare("SELECT value FROM settings WHERE channel_id = ? AND key = 'games_enabled'").get(channelId) as { value: string } | undefined;

        if (gamesEnabled?.value !== 'false') {
            // Check if this message is a trivia answer
            const wasAnswer = await checkTriviaAnswer(channelId, sender, senderId, content, sendToken);
            if (wasAnswer) return;

            // Check if this is a command to start trivia
            if (content.trim().toLowerCase() === '!trivia') {
                await startTrivia(channelId, sendToken);
                return;
            }
        }

        // 4. AI trigger mechanism
        if (aiEnabledRow?.value !== 'false') {
            const lowerContent = content.toLowerCase();
            const isMentioned = lowerContent.includes('@geebot') ||
                lowerContent.includes('geebot') ||
                lowerContent.includes('@gee_bot') ||
                lowerContent.includes('gee_bot') ||
                lowerContent.includes('gee-bot');

            if (aiMode === 'everywhere') {
                shouldTrigger = true;
            } else if (aiMode === 'random') {
                shouldTrigger = isMentioned || Math.random() < 0.20;
            } else {
                shouldTrigger = isMentioned;
            }
        }

        if (shouldTrigger) {
            console.log(`[GeeBot Trigger] AI responding to ${sender} (Mode: ${aiMode}): "${content}"`);
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

            // Generate and emit TTS audio
            console.log(`[GeeBot TTS] Generating voice audio...`);
            const audioData = await generateSpeechBase64(aiResponse);
            if (audioData) {
                console.log(`[GeeBot TTS] Broadcasting audio to overlays!`);
                io.emit('ttsAudio', { sender: 'Gee_Bot', content: aiResponse, audio: audioData });
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

        // 3a. Consolidate bot identity check
        const normalizedStreamer = streamerName.toLowerCase().trim();
        const normalizedBotSlug = BOT_KICK_SLUG.toLowerCase().trim();

        const isActuallyBot = normalizedStreamer === normalizedBotSlug ||
            normalizedStreamer === 'gee_bot' ||
            normalizedStreamer === 'gee-bot' ||
            channelId.toString() === '98951740';

        console.log(`[OAuth Debug] streamerName: "${streamerName}", BOT_KICK_SLUG: "${BOT_KICK_SLUG}", isActuallyBot: ${isActuallyBot}`);

        if (isActuallyBot) {
            console.log('[OAuth Server] Step 3: Detected BOT account — storing global bot token...');
            stmt.run('__bot__', 'bot_user_token', accessToken);
            stmt.run('__bot__', 'bot_broadcaster_id', channelId.toString());

            // Priority: userInfo.chatroom_id -> hardcoded fallback
            const finalChatroomId = (userInfo.chatroom_id || '97444794').toString();
            stmt.run('__bot__', 'chatroom_id', finalChatroomId);
            console.log(`[OAuth Server] Bot chatroom_id set: ${finalChatroomId}`);

            console.log('[OAuth Server] Bot account linked successfully! GeeBot can now send messages.');

            // Also instantly subscribe to bot's own chat
            subscribeToKickChat(finalChatroomId, channelId.toString(), streamerName);

            // Fall through to register the bot's own channel as a normal streamer so the welcome message is sent!
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

        // Return success immediately with a secure dashboard token
        const dashboardToken = crypto.randomBytes(32).toString('hex');
        stmt.run(channelId.toString(), 'dashboard_token', dashboardToken);

        res.json({ success: true, streamer: streamerName, channelId: channelId.toString(), token: dashboardToken });

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

// Dashboard Auth Middleware
function requireAuth(req: any, res: any, next: any) {
    const authHeader = req.headers.authorization;
    const channelId = req.query.channelId?.toString() || req.body.channelId;

    if (channelId === '__bot__') {
        const botTokenRow = db.prepare("SELECT value FROM settings WHERE channel_id = '__bot__' AND key = 'dashboard_token'").get() as { value: string } | undefined;
        if (!authHeader || authHeader !== `Bearer ${botTokenRow?.value}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        return next();
    }

    if (!channelId) return res.status(400).json({ error: 'Missing channelId' });

    const tokenRow = db.prepare("SELECT value FROM settings WHERE channel_id = ? AND key = 'dashboard_token'").get(channelId) as { value: string } | undefined;
    if (!tokenRow || !authHeader || authHeader !== `Bearer ${tokenRow.value}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    req.userChannelId = channelId;
    next();
}

// API Routes for Dashboard
app.get('/api/settings', requireAuth, (req: any, res) => {
    const channelId = req.userChannelId;
    const rows = db.prepare('SELECT key, value FROM settings WHERE channel_id = ?').all(channelId) as { key: string, value: string }[];
    const settingsMap = rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
    res.json(settingsMap);
});

app.post('/api/settings', requireAuth, (req: any, res) => {
    const channelId = req.userChannelId;
    const { channelId: _, ...settings } = req.body;
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (channel_id, key, value) VALUES (?, ?, ?)');

    // Use a transaction for reliability
    const transaction = db.transaction((data) => {
        for (const [key, value] of Object.entries(data)) {
            upsert.run(channelId, key, value?.toString());
        }
    });

    transaction(settings);
    res.json({ status: 'success' });
});

// Ad Schedule Management
app.get('/api/ads', requireAuth, (req: any, res) => {
    const channelId = req.userChannelId;
    const ads = db.prepare('SELECT * FROM ad_schedule WHERE channel_id = ?').all(channelId);
    res.json(ads);
});

app.post('/api/ads', requireAuth, (req: any, res) => {
    const channelId = req.userChannelId;
    const { content, interval_minutes } = req.body;
    db.prepare('INSERT INTO ad_schedule (channel_id, content, interval_minutes) VALUES (?, ?, ?)')
        .run(channelId, content, interval_minutes);
    res.json({ status: 'success' });
});

app.delete('/api/ads/:id', requireAuth, (req: any, res: any) => {
    // In a bulletproof system, check if this ad belongs to channelId
    db.prepare('DELETE FROM ad_schedule WHERE id = ?').run(req.params.id);
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

            // 0. Check if bot is even enabled for this channel
            const botEnabledRow = db.prepare("SELECT value FROM settings WHERE channel_id = ? AND key = 'bot_enabled'").get(channelId) as { value: string } | undefined;
            if (botEnabledRow?.value === 'false') {
                console.log(`[Webhook] Bot is DISABLED for channel ${channelId}.`);
                return;
            }

            // 0.5 AUTO-MOD FILTER
            const forbiddenWords = ['nigger', 'faggot', 'retard', 'tranny']; // Basic starter list for auto-mod
            const lowerContent = content.toLowerCase();
            if (forbiddenWords.some(word => lowerContent.includes(word))) {
                console.log(`[AutoMod] Caught forbidden word from ${sender}`);
                const sendToken = getSendToken(channelId);
                if (sendToken) {
                    await kickApi.sendChatMessage(channelId, `⚠️ @${sender} Please watch your language! That word is not allowed here.`, sendToken);
                }
                return; // Stop processing entirely
            }

            // 1. Save to Chat History and Track Activity (Points Points Points!)
            const insertChat = db.prepare('INSERT INTO chat_history (channel_id, user_id, username, message) VALUES (?, ?, ?, ?)');
            insertChat.run(channelId, senderId, sender, content);
            handleActivity(channelId, sender, senderId);

            // 2. Broadcast raw message to Frontend overlay via WebSockets
            io.emit('chatMessage', { sender, content });

            // 3. AI trigger mechanism
            const cleanSender = sender.replace(/^@/, '');
            const normalizedSender = cleanSender.toLowerCase().replace(/_/g, '-');
            const normalizedBot = BOT_KICK_SLUG.toLowerCase().replace(/_/g, '-');
            const isBotSelf = normalizedSender === normalizedBot || normalizedSender === 'gee-bot' || normalizedSender === 'geebot' || normalizedSender === 'gee_bot';

            if (isBotSelf) return;

            // Fetch AI settings (needed for both game and AI logic)
            const aiEnabledRow = db.prepare("SELECT value FROM settings WHERE channel_id = ? AND key = 'ai_enabled'").get(channelId) as { value: string } | undefined;
            const aiProbRow = db.prepare("SELECT value FROM settings WHERE channel_id = ? AND key = 'ai_probability'").get(channelId) as { value: string } | undefined;
            const aiMode = aiProbRow?.value || 'mentions';

            // 3. GAME ENGINE: Check for trivia answers or commands
            const sendToken = getSendToken(channelId);

            // -- OBS Widget Logic: Polls & Alerts --
            const args = content.split(' ');
            const cmd = args[0].toLowerCase();

            if (cmd === '!testalert') {
                console.log(`[GeeBot Widgets] Sending test alert to channel ${channelId}`);
                io.emit('streamAlert', { type: 'test', username: sender });
                await kickApi.sendChatMessage(channelId, `@${sender} sent a test alert to the overlay!`, sendToken);
                return;
            }

            if (cmd === '!poll') {
                // Usage: !poll "Question?" "Option 1" "Option 2"
                const parts = content.match(/(".*?"|[^"\s]+)+(?=\s*|\s*$)/g) || [];
                if (parts.length >= 3) {
                    const question = parts[1].replace(/"/g, '');
                    const options = parts.slice(2).map((p: string) => p.replace(/"/g, ''));

                    activePolls.set(channelId, {
                        question,
                        options,
                        votes: new Array(options.length).fill(0),
                        total: 0,
                        votedUsers: new Set()
                    });

                    io.emit('pollStart', { question, options, channelId });
                    await kickApi.sendChatMessage(channelId, `📊 Poll Started: ${question} Type !vote 1, !vote 2, etc.`, sendToken);

                    // Auto-end poll after 60 seconds
                    setTimeout(() => {
                        const poll = activePolls.get(channelId);
                        if (poll) {
                            let maxVotes = -1;
                            let winnerIdx = -1;
                            poll.votes.forEach((v, idx) => {
                                if (v > maxVotes) { maxVotes = v; winnerIdx = idx; }
                            });
                            const winner = maxVotes > 0 ? poll.options[winnerIdx] : null;
                            io.emit('pollEnd', { winner, channelId });
                            activePolls.delete(channelId);
                            kickApi.sendChatMessage(channelId, winner ? `📊 Poll Ended! Winner: ${winner}` : `📊 Poll Ended! No votes cast.`, sendToken);
                        }
                    }, 60000);
                    return;
                }
            }

            if (cmd === '!vote') {
                const poll = activePolls.get(channelId);
                if (poll && !poll.votedUsers.has(senderId)) {
                    const optionNum = parseInt(args[1]);
                    if (!isNaN(optionNum) && optionNum >= 1 && optionNum <= poll.options.length) {
                        poll.votes[optionNum - 1]++;
                        poll.total++;
                        poll.votedUsers.add(senderId);
                        io.emit('pollUpdate', { votes: poll.votes, total: poll.total, channelId });
                        return; // Voted successfully
                    }
                }
            }

            // Chat Commands
            const wasCommand = await handleCommand(channelId, sender, senderId, content, sendToken || '');
            if (wasCommand) return; // Stop processing if the message was a standard chat command

            const gamesEnabled = db.prepare("SELECT value FROM settings WHERE channel_id = ? AND key = 'games_enabled'").get(channelId) as { value: string } | undefined;

            if (gamesEnabled?.value !== 'false') {
                const wasAnswer = await checkTriviaAnswer(channelId, sender, senderId, content, sendToken);
                if (wasAnswer) return;

                if (content.trim().toLowerCase() === '!trivia') {
                    await startTrivia(channelId, sendToken);
                    return;
                }
            }

            let shouldTrigger = false;
            const isMentioned = lowerContent.includes('@geebot') || lowerContent.includes('geebot') || lowerContent.includes('@gee_bot') || lowerContent.includes('gee_bot') || lowerContent.includes('gee-bot');

            if (aiEnabledRow?.value !== 'false') {
                if (aiMode === 'everywhere') {
                    shouldTrigger = true;
                } else if (aiMode === 'random') {
                    shouldTrigger = isMentioned || Math.random() < 0.20;
                } else {
                    shouldTrigger = isMentioned;
                }
            }

            if (shouldTrigger) {
                const aiResponse = await generateChatResponse(sender, content);
                console.log(`[GeeBot AI Webhook Replying]: ${aiResponse}`);

                try {
                    const sendToken = getSendToken(channelId);
                    await kickApi.sendChatMessage(channelId, aiResponse, sendToken);
                } catch (err) {
                    console.error('Failed to send official chat response:', err);
                }

                io.emit('chatMessage', { sender: 'Gee_Bot', content: aiResponse });

                // Generate and emit TTS audio
                console.log(`[GeeBot TTS] Generating voice audio...`);
                const audioData = await generateSpeechBase64(aiResponse);
                if (audioData) {
                    console.log(`[GeeBot TTS] Broadcasting audio to overlays!`);
                    io.emit('ttsAudio', { sender: 'Gee_Bot', content: aiResponse, audio: audioData });
                }
            }
        }
    } catch (error) {
        console.error('Webhook processing error:', error);
    }
});

// Start the server
httpServer.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`GeeBot Core Service running on port ${PORT}`);
    console.log(`WebSocket Server listening on port ${PORT}`);

    // Auto-reconnect Pusher to all previously linked channels
    const linkedChannels = db.prepare("SELECT channel_id, value FROM settings WHERE key = 'streamer_name' AND channel_id != '__bot__'").all() as { channel_id: string, value: string }[];

    // Add the bot's own channel to the subscription list if we have its data
    const botBroadcasterId = db.prepare("SELECT value FROM settings WHERE channel_id = '__bot__' AND key = 'bot_broadcaster_id'").get() as { value: string } | undefined;
    if (botBroadcasterId?.value) {
        linkedChannels.push({ channel_id: botBroadcasterId.value, value: BOT_KICK_SLUG });
    }

    for (const channel of linkedChannels) {
        // Find chatroom_id (priority: channel_id specific, fallback to __bot__ if it matches)
        let chatroomIdRow = db.prepare('SELECT value FROM settings WHERE channel_id = ? AND key = ?').get(channel.channel_id, 'chatroom_id') as { value: string } | undefined;

        // If it's the bot's own channel, we might have stored it under '__bot__'
        if (!chatroomIdRow && channel_id_matches_bot(channel.channel_id)) {
            chatroomIdRow = db.prepare("SELECT value FROM settings WHERE channel_id = '__bot__' AND key = 'chatroom_id'").get() as { value: string } | undefined;
        }

        if (chatroomIdRow?.value) {
            subscribeToKickChat(chatroomIdRow.value, channel.channel_id, channel.value);
        }
    }

    startAdScheduler();
});

function startAdScheduler() {
    console.log('[Ad Scheduler] Starting background service...');
    setInterval(async () => {
        try {
            const now = new Date().toISOString();
            // Find all enabled ads across all channels
            const ads = db.prepare(`
                SELECT * FROM ad_schedule 
                WHERE is_enabled = 1 
                AND (last_sent IS NULL OR datetime(last_sent, '+' || interval_minutes || ' minutes') <= datetime('now'))
            `).all() as any[];

            for (const ad of ads) {
                // Check if ads are enabled for this specific channel
                const adsEnabled = db.prepare("SELECT value FROM settings WHERE channel_id = ? AND key = 'ads_enabled'").get(ad.channel_id) as { value: string } | undefined;
                if (adsEnabled?.value === 'false') continue;

                console.log(`[Ad Scheduler] Posting ad to channel ${ad.channel_id}: ${ad.content.substring(0, 20)}...`);

                try {
                    const sendToken = getSendToken(ad.channel_id);
                    if (sendToken) {
                        await kickApi.sendChatMessage(ad.channel_id, ad.content, sendToken);
                        db.prepare('UPDATE ad_schedule SET last_sent = ? WHERE id = ?').run(now, ad.id);
                    }
                } catch (err: any) {
                    console.error(`[Ad Scheduler] Failed to send ad: ${err.message}`);
                }
            }
        } catch (err) {
            console.error('[Ad Scheduler] Error in loop:', err);
        }
    }, 60000); // Check every minute
}

function channel_id_matches_bot(channelId: string): boolean {
    const botId = db.prepare("SELECT value FROM settings WHERE channel_id = '__bot__' AND key = 'bot_broadcaster_id'").get() as { value: string } | undefined;
    return botId?.value === channelId;
}

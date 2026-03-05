import Pusher from 'pusher-js';
import ws from 'ws';

// Assign WebSocket for Node.js compatibility
(Pusher as any).Runtime.createWebSocket = (url: string) => new ws(url);

const APP_KEY = '32cbd69e4b950bf97679';
const CLUSTER = 'us2';
const CHATROOM_ID = '97444794'; // gee-bot's chatroom ID

console.log(`[Diagnostic] Connecting to Pusher (Cluster: ${CLUSTER}, Room: ${CHATROOM_ID})...`);

const pusher = new Pusher(APP_KEY, {
    cluster: CLUSTER,
    wsHost: 'ws-us2.pusher.com',
    wsPort: 443,
    wssPort: 443,
    forceTLS: true,
    enabledTransports: ['ws', 'wss']
});

pusher.connection.bind('state_change', (states: any) => {
    console.log(`[Connection State] ${states.previous} -> ${states.current}`);
});

pusher.connection.bind('error', (err: any) => {
    console.error('[Connection Error]', err);
});

const channelName = `chatrooms.${CHATROOM_ID}.v2`;
const channel = pusher.subscribe(channelName);

channel.bind_global((eventName: string, data: any) => {
    console.log(`\n--- INCOMING EVENT: ${eventName} ---`);
    console.log(JSON.stringify(data, null, 2).substring(0, 500));
});

console.log(`[Diagnostic] Subscribed to ${channelName}. Listening for events... Please type a message in the Kick chat now.`);

// Keep process alive
setInterval(() => { }, 1000);

import Pusher from 'pusher-js';

const KICK_PUSHER_APP_KEY = '32cbd69e4b950bf97679';
const cluster = 'us2';
const chatroomId = '97444794'; // gee-bot

console.log(`Starting All-Event Listener for Chatroom ${chatroomId} on ${cluster}...`);

const pusher = new Pusher(KICK_PUSHER_APP_KEY, {
    cluster: cluster,
    wsHost: `ws-${cluster}.pusher.com`,
    wsPort: 443,
    wssPort: 443,
    forceTLS: true,
    enabledTransports: ['ws', 'wss']
});

const channelName = `chatrooms.${chatroomId}.v2`;
const channel = pusher.subscribe(channelName);

pusher.connection.bind('connected', () => {
    console.log(`[${cluster}] CONNECTED!`);
});

// Listen to ALL events
channel.bind_global((eventName: string, data: any) => {
    console.log(`[EVENT] ${eventName}:`, JSON.stringify(data).substring(0, 200));
});

setTimeout(() => {
    console.log('Listener finished after 60s.');
    process.exit(0);
}, 60000);

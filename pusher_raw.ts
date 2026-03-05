import Pusher from 'pusher-js';

const KICK_PUSHER_APP_KEY = '32cbd69e4b950bf97679';
const cluster = 'us2';
const chatroomId = '97444794';

console.log(`Starting RAW Listener for Chatroom ${chatroomId}...`);

const pusher = new Pusher(KICK_PUSHER_APP_KEY, {
    cluster: cluster,
    wsHost: `ws-us2.pusher.com`,
    wsPort: 443,
    wssPort: 443,
    forceTLS: true,
    enabledTransports: ['ws', 'wss']
});

pusher.connection.bind('state_change', (states: any) => {
    console.log(`[STATE] ${states.previous} -> ${states.current}`);
});

const channelName = `chatrooms.${chatroomId}.v2`;
const channel = pusher.subscribe(channelName);

channel.bind_global((eventName: string, data: any) => {
    console.log(`[EVENT] ${eventName}: ${JSON.stringify(data)}`);
});

setTimeout(() => {
    console.log('Finished.');
    process.exit(0);
}, 45000);

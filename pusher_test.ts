import Pusher from 'pusher-js';

const KICK_PUSHER_APP_KEY = '32cbd69e4b950bf97679';
const clusters = ['us2', 'us3', 'eu', 'ap1'];
const chatroomId = '97444794'; // gee-bot

console.log(`Starting Pusher Diagnostic for Chatroom ${chatroomId}...`);

clusters.forEach(cluster => {
    console.log(`[${cluster}] Attempting connection...`);
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

    pusher.connection.bind('error', (err: any) => {
        console.log(`[${cluster}] ERROR:`, err);
    });

    channel.bind('App\\Events\\ChatMessageEvent', (data: any) => {
        console.log(`[${cluster}] DATA RECEIVED!`, JSON.stringify(data).substring(0, 100));
    });
});

setTimeout(() => {
    console.log('Diagnostic finished after 30s.');
    process.exit(0);
}, 30000);

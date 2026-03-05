const fs = require('fs');
const content = fs.readFileSync('pusher_clean.txt', 'utf16le');
const lines = content.split('\n');
lines.forEach(line => {
    if (line.includes('App\\Events\\ChatMessageEvent')) {
        console.log('--- EVENT DATA START ---');
        console.log(line);
        console.log('--- EVENT DATA END ---');
    }
});

const fs = require('fs');
const content = fs.readFileSync('pusher_clean.txt', 'utf8');
const lines = content.split('\n');
lines.forEach(line => {
    if (line.includes('App\\Events\\ChatMessageEvent')) {
        console.log('--- EVENT FOUND ---');
        console.log(line);
    }
});

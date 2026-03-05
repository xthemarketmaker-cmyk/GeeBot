import Database from 'better-sqlite3';
const db = new Database('geebot.db');
const rows = db.prepare('SELECT username, message FROM chat_history ORDER BY id DESC LIMIT 10').all() as { username: string, message: string }[];
console.log('--- RECENT CHAT HISTORY ---');
rows.reverse().forEach(row => {
    console.log(`[${row.username}]: ${row.message}`);
});
console.log('---------------------------');

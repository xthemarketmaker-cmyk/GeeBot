import Database from 'better-sqlite3';
import path from 'path';

// Connect to or create the SQLite database
// Use a configurable path for the database file (needed for persistent storage on Railway)
const dbDirectory = process.env.DATABASE_PATH || path.join(__dirname, '..');
const dbPath = path.join(dbDirectory, 'geebot.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

// Initialize database schema
export const initDb = () => {
    // 1. Users table - tracked per channel (points vary per streamer)
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            channel_id TEXT,
            user_id TEXT,
            username TEXT,
            points INTEGER DEFAULT 0,
            messages_count INTEGER DEFAULT 0,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (channel_id, user_id)
        )
    `);

    // 2. Settings table - scoped per channel
    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            channel_id TEXT,
            key TEXT,
            value TEXT,
            PRIMARY KEY (channel_id, key)
        )
    `);

    // 3. Widget state - tracked per channel
    db.exec(`
        CREATE TABLE IF NOT EXISTS widgets (
            channel_id TEXT,
            widget_name TEXT,
            is_enabled BOOLEAN DEFAULT 1,
            config TEXT,
            PRIMARY KEY (channel_id, widget_name)
        )
    `);

    // 4. Chat History - for AI context, scoped per channel
    db.exec(`
        CREATE TABLE IF NOT EXISTS chat_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id TEXT,
            user_id TEXT,
            username TEXT,
            message TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    console.log('Database initialized successfully.');
};

export default db;

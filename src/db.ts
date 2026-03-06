import Database from 'better-sqlite3';
import path from 'path';

// Connect to or create the SQLite database
const dbDirectory = process.env.DATABASE_PATH || path.join(__dirname, '..');
const dbPath = path.join(dbDirectory, 'geebot.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

// Initialize database schema
export const initDb = () => {
    try {
        // 1. Settings Table (Scoped per channel)
        db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
                channel_id TEXT,
                key TEXT,
                value TEXT,
                PRIMARY KEY (channel_id, key)
            )
        `);

        // Check for old schema migration (if channel_id doesn't exist in a non-empty settings table)
        const settingsCols = db.pragma('table_info(settings)') as { name: string }[];
        if (settingsCols.length > 0 && !settingsCols.some(c => c.name === 'channel_id')) {
            console.log('Migrating database schema for multi-channel support...');
            db.exec(`
                CREATE TABLE settings_new (
                    channel_id TEXT,
                    key TEXT,
                    value TEXT,
                    PRIMARY KEY (channel_id, key)
                );
                INSERT INTO settings_new (channel_id, key, value) 
                SELECT '__bot__', key, value FROM settings;
                DROP TABLE settings;
                ALTER TABLE settings_new RENAME TO settings;
            `);
            // Clear other tables to recreate clean if we were on the old single-user schema
            db.exec('DROP TABLE IF EXISTS users');
            db.exec('DROP TABLE IF EXISTS widgets');
            db.exec('DROP TABLE IF EXISTS chat_history');
        }

        // 2. Users Table - tracked per channel
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

        // 3. Widget State - tracked per channel
        db.exec(`
            CREATE TABLE IF NOT EXISTS widgets (
                channel_id TEXT,
                widget_name TEXT,
                is_enabled BOOLEAN DEFAULT 1,
                config TEXT,
                PRIMARY KEY (channel_id, widget_name)
            )
        `);

        // 4. Chat History - scoped per channel
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

        // Migration check for chat_history (adding missing columns if they don't exist in old DB)
        const chatCols = db.pragma('table_info(chat_history)') as { name: string }[];
        if (chatCols.length > 0) {
            if (!chatCols.some(c => c.name === 'username')) {
                console.log('Adding missing username column to chat_history...');
                db.exec('ALTER TABLE chat_history ADD COLUMN username TEXT');
            }
            if (!chatCols.some(c => c.name === 'message')) {
                console.log('Adding missing message column to chat_history...');
                db.exec('ALTER TABLE chat_history ADD COLUMN message TEXT');
            }
        }

        // 5. Ad Schedule - for timed promotional messages
        db.exec(`
            CREATE TABLE IF NOT EXISTS ad_schedule (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id TEXT,
                content TEXT,
                interval_minutes INTEGER DEFAULT 30,
                last_sent DATETIME,
                is_enabled BOOLEAN DEFAULT 1
            )
        `);

        console.log('Database initialized successfully.');
    } catch (error) {
        console.error('Database initialization failed:', error);
    }
};

export default db;

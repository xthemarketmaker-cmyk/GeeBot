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
    try {
        const settingsCols = db.pragma('table_info(settings)') as { name: string }[];
        if (settingsCols.length > 0 && !settingsCols.some(c => c.name === 'channel_id')) {
            console.log('Migrating database schema for multi-channel support...');

            // Migrate settings, transferring old keys to __bot__ scope
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

            // Drop others to be recreated clean
            db.exec('DROP TABLE IF EXISTS users');
            db.exec('DROP TABLE IF EXISTS widgets');
            db.exec('DROP TABLE IF EXISTS chat_history');

            console.log('Migration completed successfully.');
        }
    } catch (e) {
        console.error('Migration failed:', e);
    }

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

    // 5. Timers - for periodic messages
    db.exec(`
        CREATE TABLE IF NOT EXISTS timers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id TEXT,
            name TEXT,
            message TEXT,
            interval_minutes INTEGER,
            last_run DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_enabled BOOLEAN DEFAULT 1
        )
    `);

    console.log('Database initialized successfully.');
};

export default db;

import db from './db';
import * as kickApi from './kick_api';

export async function handleCommand(
    channelId: string,
    sender: string,
    senderId: string,
    content: string,
    sendToken: string
): Promise<boolean> {
    const args = content.split(' ');
    const command = args[0].toLowerCase();

    // Commands that don't need points check
    if (command === '!8ball') {
        const question = args.slice(1).join(' ');
        if (!question) {
            await kickApi.sendChatMessage(channelId, `@${sender} You need to ask a question! Ex: !8ball Will I win?`, sendToken);
            return true;
        }
        const answers = [
            "It is certain.", "It is decidedly so.", "Without a doubt.", "Yes - definitely.", "You may rely on it.",
            "As I see it, yes.", "Most likely.", "Outlook good.", "Yes.", "Signs point to yes.",
            "Reply hazy, try again.", "Ask again later.", "Better not tell you now.", "Cannot predict now.", "Concentrate and ask again.",
            "Don't count on it.", "My reply is no.", "My sources say no.", "Outlook not so good.", "Very doubtful."
        ];
        const answer = answers[Math.floor(Math.random() * answers.length)];
        await kickApi.sendChatMessage(channelId, `🎱 @${sender} ${answer}`, sendToken);
        return true;
    }

    if (command === '!lurk') {
        await kickApi.sendChatMessage(channelId, `@${sender} is now lurking! We appreciate the support! 💖`, sendToken);
        return true;
    }

    if (command === '!so' || command === '!shoutout') {
        const target = args[1]?.replace('@', '');
        if (!target) {
            await kickApi.sendChatMessage(channelId, `@${sender} You need to specify a user! Ex: !so @user`, sendToken);
            return true;
        }
        await kickApi.sendChatMessage(channelId, `📣 BIG SHOUTOUT to @${target}! Go drop them a follow at kick.com/${target} !`, sendToken);
        return true;
    }

    if (command === '!title' || command === '!uptime') {
        try {
            const streamerNameRow = db.prepare("SELECT value FROM settings WHERE channel_id = ? AND key = 'streamer_name'").get(channelId) as { value: string };
            const streamerSlug = streamerNameRow ? streamerNameRow.value : '';
            if (streamerSlug) {
                const channelData = await kickApi.getChannelInfo(streamerSlug);
                const isLive = channelData?.livestream != null;

                if (command === '!title') {
                    const title = isLive ? channelData.livestream.session_title : channelData.previous_livestreams?.[0]?.session_title || 'No recent title found.';
                    await kickApi.sendChatMessage(channelId, `📺 Stream Title: ${title}`, sendToken);
                } else if (command === '!uptime') {
                    if (isLive) {
                        const startTime = new Date(channelData.livestream.created_at).getTime();
                        const now = Date.now();
                        const diffMs = now - startTime;
                        const hours = Math.floor(diffMs / 3600000);
                        const mins = Math.floor((diffMs % 3600000) / 60000);
                        await kickApi.sendChatMessage(channelId, `⏱️ We've been live for ${hours} hours and ${mins} minutes!`, sendToken);
                    } else {
                        await kickApi.sendChatMessage(channelId, `❌ The stream is currently offline.`, sendToken);
                    }
                }
            }
        } catch (err) {
            console.error('Failed to get channel info:', err);
        }
        return true;
    }

    // Interactive Points Commands
    if (command === '!points') {
        const userRow = db.prepare('SELECT points FROM users WHERE channel_id = ? AND user_id = ?').get(channelId, senderId) as { points: number } | undefined;
        const pts = userRow ? userRow.points : 0;
        await kickApi.sendChatMessage(channelId, `@${sender} You have ${pts} points!`, sendToken);
        return true;
    }

    if (command === '!gamble') {
        const amountStr = args[1];
        if (!amountStr || isNaN(parseInt(amountStr))) {
            await kickApi.sendChatMessage(channelId, `@${sender} How much do you want to gamble? Ex: !gamble 100`, sendToken);
            return true;
        }

        const bet = parseInt(amountStr);
        if (bet <= 0) {
            await kickApi.sendChatMessage(channelId, `@${sender} You must gamble an amount greater than 0!`, sendToken);
            return true;
        }

        const userRow = db.prepare('SELECT points FROM users WHERE channel_id = ? AND user_id = ?').get(channelId, senderId) as { points: number } | undefined;
        const currentPoints = userRow ? userRow.points : 0;

        if (currentPoints < bet) {
            await kickApi.sendChatMessage(channelId, `@${sender} You don't have enough points! You only have ${currentPoints}.`, sendToken);
            return true;
        }

        const win = Math.random() >= 0.5;
        if (win) {
            const newTotal = currentPoints + bet;
            db.prepare('UPDATE users SET points = ? WHERE channel_id = ? AND user_id = ?').run(newTotal, channelId, senderId);
            await kickApi.sendChatMessage(channelId, `🎰 @${sender} WON ${bet} points! You now have ${newTotal} points.`, sendToken);
        } else {
            const newTotal = currentPoints - bet;
            db.prepare('UPDATE users SET points = ? WHERE channel_id = ? AND user_id = ?').run(newTotal, channelId, senderId);
            await kickApi.sendChatMessage(channelId, `🎰 @${sender} lost ${bet} points... You now have ${newTotal} points.`, sendToken);
        }
        return true;
    }

    return false; // Not a recognized command
}

export function handleActivity(channelId: string, sender: string, senderId: string) {
    db.prepare(`
        INSERT INTO users (channel_id, user_id, username, points, messages_count, last_seen)
        VALUES (?, ?, ?, 10, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(channel_id, user_id) 
        DO UPDATE SET 
            username = excluded.username,
            points = points + 1,
            messages_count = messages_count + 1,
            last_seen = CURRENT_TIMESTAMP
    `).run(channelId, senderId, sender);
}

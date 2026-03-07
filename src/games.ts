import OpenAI from 'openai';
import dotenv from 'dotenv';
import db from './db';

dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.GROK_API_KEY || '',
    baseURL: 'https://api.x.ai/v1'
});
import * as kickApi from './kick_api';

interface ActiveTrivia {
    question: string;
    answer: string;
    startTime: number;
    points: number;
    category: string;
}

// Memory store for active games per channel
const activeGames = new Map<string, ActiveTrivia>();

/**
 * Generates a funny, unhinged trivia question using Grok 3
 */
async function generateAITrivia(): Promise<{ question: string; answer: string; category: string; flavor: string } | null> {
    try {
        const prompt = `Generate ONE unique, funny, and slightly unhinged trivia question for a Kick.com stream chat.
The question can be about gaming, internet culture, weird history, or absolute nonsense.
Make the answer a single word or a very short phrase (maximum 3 words).

Return ONLY a JSON object with this exact format:
{
  "question": "The actual question text",
  "answer": "The correct answer",
  "category": "A funny category name",
  "flavor": "A funny, unhinged intro or comment about the question"
}`;

        const response = await openai.chat.completions.create({
            model: 'grok-3',
            messages: [{ role: 'system', content: prompt }],
            temperature: 0.9,
            response_format: { type: 'json_object' }
        });

        const content = response.choices[0]?.message?.content;
        if (!content) return null;

        return JSON.parse(content);
    } catch (error) {
        console.error('[Games] AI Trivia Gen Error:', error);
        return null;
    }
}

/**
 * Starts a trivia game in a channel
 */
export async function startTrivia(channelId: string, sendToken?: string) {
    if (activeGames.has(channelId)) {
        await kickApi.sendChatMessage(channelId, "⚠️ A trivia game is already running! Answer the current question first.", sendToken);
        return;
    }

    console.log(`[Games] Starting AI Trivia for channel ${channelId}...`);
    const data = await generateAITrivia();

    if (!data) {
        await kickApi.sendChatMessage(channelId, "❌ My brain is too fried to think of a question right now. Try again in a bit!", sendToken);
        return;
    }

    const game: ActiveTrivia = {
        question: data.question,
        answer: data.answer.toLowerCase().trim(),
        startTime: Date.now(),
        points: Math.floor(Math.random() * 50) + 50, // 50-100 points
        category: data.category
    };

    activeGames.set(channelId, game);

    const announcement = `🎲 TRIVIA TIME! (Category: ${data.category}) \n\n"${data.question}" \n\n💰 Reward: ${game.points} points! \n\n${data.flavor}`;
    await kickApi.sendChatMessage(channelId, announcement, sendToken);

    // Auto-timeout after 60 seconds if no one answers
    setTimeout(async () => {
        if (activeGames.has(channelId) && activeGames.get(channelId)?.startTime === game.startTime) {
            activeGames.delete(channelId);
            await kickApi.sendChatMessage(channelId, `⏳ Trivia Timeout! No one got it. The answer was: "${data.answer}". Better luck next time, losers! 🤡`, sendToken);
        }
    }, 60000);
}

/**
 * Checks chat messages for correct trivia answers
 */
export async function checkTriviaAnswer(channelId: string, username: string, userId: string, message: string, sendToken?: string): Promise<boolean> {
    const game = activeGames.get(channelId);
    if (!game) return false;

    const cleanMsg = message.toLowerCase().trim();

    // Check if the message contains the answer
    if (cleanMsg === game.answer || cleanMsg.includes(game.answer)) {
        activeGames.delete(channelId);

        // Award points in DB
        const upsertUser = db.prepare(`
            INSERT INTO users (channel_id, user_id, username, points)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(channel_id, user_id) DO UPDATE SET
                points = points + excluded.points,
                username = excluded.username,
                last_seen = CURRENT_TIMESTAMP
        `);
        upsertUser.run(channelId, userId, username, game.points);

        const winMsg = `🎉 WINNER! @${username} got it right! The answer was "${game.answer}". \n\n💰 You've been awarded ${game.points} points! Total smarty pants move. 🧠`;
        await kickApi.sendChatMessage(channelId, winMsg, sendToken);
        return true;
    }

    return false;
}

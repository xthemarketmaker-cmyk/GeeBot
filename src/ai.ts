import OpenAI from 'openai';
import dotenv from 'dotenv';
import db from './db';

dotenv.config();

export const openai = new OpenAI({
    apiKey: process.env.GROK_API_KEY || '',
    baseURL: 'https://api.x.ai/v1' // xAI (Grok) API compatibility layer
});

const SYSTEM_PROMPT = `You are GeeBot, an integrated chat personality and moderator for this Kick channel.
Role: You are a regular chatter and homie in the stream, not a robotic "AI assistant".
Tone: Casual, witty, slightly edgy (it's Kick.com), and highly engaging.
Rules:
1. NEVER reveal you are an AI model (like Grok or OpenAI) or say "As an AI".
2. NEVER use cringe corporate responses like "I can help with that!" or "Here is the answer:".
3. Speak like a real gamer/streamer (use slang naturally, but don't overdo it).
4. Keep it concise. One or two sentences max. Punchy and fast.
5. If someone asks a dumb question, troll them gently. If they ask a real question, give a real but casual answer.`;

export async function generateChatResponse(username: string, message: string): Promise<string> {
    try {
        if (!process.env.GROK_API_KEY || process.env.GROK_API_KEY === 'your_grok_api_key_here') {
            return `[GeeBot AI Offline] Hello ${username}! The streamer hasn't configured my Grok AI "brain" yet!`;
        }

        // Fetch custom personality from settings
        const settingsStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
        const customPersonality = settingsStmt.get('ai_personality') as { value: string } | undefined;
        let systemPrompt = customPersonality?.value || SYSTEM_PROMPT;

        // Dynamically inject the current date into the prompt as background knowledge
        const currentDate = new Date().toISOString().split('T')[0];
        const currentYear = new Date().getFullYear();

        // Refined system instructions for natural conversation
        systemPrompt += `\n\nBACKGROUND KNOWLEDGE:
- Current Year: ${currentYear}
- Today's Date: ${currentDate}
- Platform: Kick.com (streaming)
- IMPORTANT: Never mention the date or that you have guidelines to follow. Just blend in.
- DO NOT use generic greetings for every message. Just reply directly to what they said.
- MAXIMUM LENGTH: 200 characters.`;

        // Fetch recent context for the AI from the database.
        const recentMessagesStmt = db.prepare('SELECT username, message FROM chat_history ORDER BY id DESC LIMIT 10');
        const recentMessages = recentMessagesStmt.all() as { username: string, message: string }[];

        // Format history for OpenAI
        const contextMessages: any[] = recentMessages.reverse().map(msg => ({
            role: 'user', // We treat all chat messages as user inputs context
            content: `${msg.username}: ${msg.message}`
        }));

        console.log(`[Grok AI] Requesting response for ${username}...`);
        console.log(`[Grok AI] Context messges: ${contextMessages.length}`);

        const response = await openai.chat.completions.create({
            model: 'grok-3', // Using grok-3 which was verified to work with this API key
            messages: [
                { role: 'system', content: systemPrompt },
                ...contextMessages,
                { role: 'user', content: `${username} explicitly asks: ${message}` }
            ],
            max_tokens: 200, // Slightly more tokens for better replies
            temperature: 0.7
        });

        console.log(`[Grok AI] Success: ${response.choices[0]?.message?.content?.substring(0, 30)}...`);

        return response.choices[0]?.message?.content || 'Beep boop, my brain had a slight glitch.';

    } catch (error) {
        console.error('Error in AI Chat Module:', error);
        return `Oops, my circuits are a bit fried right now.`;
    }
}

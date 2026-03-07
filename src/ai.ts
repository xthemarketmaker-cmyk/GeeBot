import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import db from './db';

dotenv.config();

const SYSTEM_PROMPT = `You are GeeBot, an integrated chat personality and moderator for this Kick channel.
Role: You are a regular chatter and homie in the stream, not a robotic "AI assistant".
Tone: Casual, witty, slightly edgy (it's Kick.com), and highly engaging.
Rules:
1. NEVER reveal you are an AI model (like Grok or OpenAI) or say "As an AI".
2. NEVER use cringe corporate responses like "I can help with that!" or "Here is the answer:".
3. Speak like a real gamer/streamer (use slang naturally, but don't overdo it).
4. Keep it concise. One or two sentences max. Punchy and fast.
5. If someone asks a dumb question, troll them gently. If they ask a real question, give a real but casual answer.`;

export async function generateChatResponse(username: string, message: string, channelId?: string): Promise<string> {
    try {
        // Fetch Provider & Key Settings
        let provider = 'grok';
        let customKey = '';
        let customPersonality = '';

        if (channelId) {
            const getSetting = (key: string) => {
                const row = db.prepare('SELECT value FROM settings WHERE channel_id = ? AND key = ?').get(channelId, key) as { value: string } | undefined;
                return row?.value || '';
            };
            provider = getSetting('ai_provider') || 'grok';
            customKey = getSetting('ai_custom_key') || '';
            customPersonality = getSetting('ai_personality') || '';
        }

        let systemPrompt = customPersonality || SYSTEM_PROMPT;
        const currentDate = new Date().toISOString().split('T')[0];
        const currentYear = new Date().getFullYear();

        systemPrompt += `\n\nBACKGROUND KNOWLEDGE:
- Current Year: ${currentYear}
- Today's Date: ${currentDate}
- Platform: Kick.com (streaming)
- IMPORTANT: Never mention the date or that you have guidelines to follow. Just blend in.
- DO NOT use generic greetings for every message. Just reply directly to what they said.
- MAXIMUM LENGTH: 200 characters.`;

        // Fetch Recent Context
        let recentMessages: { username: string, message: string }[] = [];
        if (channelId) {
            const stmt = db.prepare('SELECT username, message FROM chat_history WHERE channel_id = ? ORDER BY id DESC LIMIT 10');
            recentMessages = stmt.all(channelId) as { username: string, message: string }[];
        }

        // Format historical context for standard OpenAI-compatible endpoints
        const oaiMessages: any[] = recentMessages.reverse().map(msg => ({
            role: 'user', // Treat chat history as purely user context to avoid hallucinating Assistant replies
            content: `${msg.username}: ${msg.message}`
        }));

        console.log(`[AI Brain] Routing request to provider: ${provider.toUpperCase()}`);

        // --- DYNAMIC AI ROUTING ENGINE ---

        // 1. ANTHROPIC CLAUDE
        if (provider === 'claude') {
            const apiKey = customKey || process.env.ANTHROPIC_API_KEY;
            if (!apiKey) return `[GeeBot AI Offline] The Claude API key is missing!`;

            const anthropic = new Anthropic({ apiKey });
            // Claude uses 'user'/'assistant' arrays, mapping all history to a single user block for now
            const claudeHistory = oaiMessages.map(m => m.content).join('\n');
            const finalMessage = `[Recent Chat Context]\n${claudeHistory}\n\n[Current User Message]\n${username} explicitly asks: ${message}`;

            const response = await anthropic.messages.create({
                model: 'claude-3-7-sonnet-20250219',
                max_tokens: 200,
                system: systemPrompt,
                messages: [{ role: 'user', content: finalMessage }],
                temperature: 0.7
            });
            // Extract the text block if it exists
            const textBlock = response.content.find((block: any) => block.type === 'text');
            return textBlock && 'text' in textBlock ? textBlock.text : 'Error generating response from Claude.';
        }

        // 2. GOOGLE GEMINI
        if (provider === 'gemini') {
            const apiKey = customKey || process.env.GEMINI_API_KEY;
            if (!apiKey) return `[GeeBot AI Offline] The Gemini API key is missing!`;

            const ai = new GoogleGenAI({ apiKey });
            const geminiHistory = oaiMessages.map(m => m.content).join('\n');
            const finalMessage = `[Recent Context]\n${geminiHistory}\n\nUser ${username}: ${message}`;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-pro',
                contents: finalMessage,
                config: {
                    systemInstruction: systemPrompt,
                    temperature: 0.7,
                    maxOutputTokens: 200
                }
            });
            return response.text || 'Error generating response from Gemini.';
        }

        // 3. OPENAI / GROK / DEEPSEEK (REST Compatible)
        let baseURL: string | undefined = undefined;
        let apiKey = '';
        let model = '';

        if (provider === 'grok') {
            baseURL = 'https://api.x.ai/v1';
            apiKey = customKey || process.env.GROK_API_KEY || '';
            model = 'grok-3';
        } else if (provider === 'deepseek') {
            baseURL = 'https://api.deepseek.com';
            apiKey = customKey || process.env.DEEPSEEK_API_KEY || '';
            model = 'deepseek-chat';
        } else {
            // Default OpenAI
            apiKey = customKey || process.env.OPENAI_API_KEY || '';
            model = 'gpt-4o';
        }

        if (!apiKey) return `[GeeBot AI Offline] The ${provider.toUpperCase()} API key is missing!`;

        const openai = new OpenAI({ apiKey, baseURL });

        const response = await openai.chat.completions.create({
            model: model,
            messages: [
                { role: 'system', content: systemPrompt },
                ...oaiMessages,
                { role: 'user', content: `${username} explicitly asks: ${message}` }
            ],
            max_tokens: 200,
            temperature: 0.7
        });

        return response.choices[0]?.message?.content || 'Beep boop, my brain had a slight glitch.';

    } catch (error) {
        console.error(`[AI Engine Error]:`, error);
        return `Oops, my circuits are a bit fried right now. Check your Dashboard AI settings.`;
    }
}

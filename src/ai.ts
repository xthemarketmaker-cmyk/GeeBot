import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.GROK_API_KEY || '',
    baseURL: 'https://api.x.ai/v1' // xAI (Grok) API compatibility layer
});

/**
 * Generates an AI response using the Grok API.
 * 
 * @param message - The user's current message
 * @param context - Recent chat history (formatted as a string)
 * @param systemPrompt - The bot's personality and instructions
 */
export async function generateChatResponse(message: string, context: string, systemPrompt: string): Promise<string> {
    try {
        if (!process.env.GROK_API_KEY) {
            return `[AI Offline] API Key missing.`;
        }

        console.log(`[Grok AI] Generating response...`);

        const response = await openai.chat.completions.create({
            model: 'grok-beta',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'system', content: `Conversation Context:\n${context}` },
                { role: 'user', content: message }
            ],
            max_tokens: 280, // Twitter/Kick style concise replies
            temperature: 0.7
        });

        const reply = response.choices[0]?.message?.content || 'Beep boop, brain glitch.';
        console.log(`[Grok AI] Response: ${reply.substring(0, 50)}...`);
        return reply;

    } catch (error) {
        console.error('Error in AI Chat Module:', error);
        return `Oops, my circuits are a bit fried right now.`;
    }
}

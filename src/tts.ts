import dotenv from 'dotenv';
dotenv.config();

/**
 * Generates an MP3 audio buffer from text using ElevenLabs API and returns it as a base64 Data URI.
 * @param text The text to convert to speech.
 * @returns A base64 encoded audio string ready to be played in the browser, or null if it fails.
 */
export async function generateSpeechBase64(text: string): Promise<string | null> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
        console.warn('[TTS] ElevenLabs API key not found in .env. Skipping TTS generation.');
        return null;
    }

    // Default voice ID if not specified in .env (e.g., a good default AI voice)
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJcg';
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    try {
        console.log(`[TTS] Requesting audio for text: "${text.substring(0, 30)}..."`);
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            body: JSON.stringify({
                text,
                model_id: 'eleven_multilingual_v2',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75
                }
            })
        });

        if (!response.ok) {
            console.error(`[TTS] ElevenLabs API Error: ${response.status} ${response.statusText}`);
            return null;
        }

        const arrayBuffer = await response.arrayBuffer();
        const base64Audio = Buffer.from(arrayBuffer).toString('base64');
        return `data:audio/mpeg;base64,${base64Audio}`;

    } catch (error) {
        console.error('[TTS] Error generating speech:', error);
        return null;
    }
}

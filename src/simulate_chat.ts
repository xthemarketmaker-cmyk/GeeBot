/**
 * Simulates a Kick Chat Message event to trigger GeeBot's AI.
 */
async function simulateMessage(username: string, content: string) {
    console.log(`[Simulation] Sending message from ${username}: "${content}"`);

    const payload = {
        event: 'ChatMessageSent',
        data: {
            id: 'sim_' + Date.now(),
            channel_id: 'gee_bot_sim_channel',
            content: content,
            sender: {
                id: '12345',
                username: username
            }
        }
    };

    try {
        const response = await fetch('http://localhost:3000/webhook/kick', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log('Successfully sent simulation webhook.');
        } else {
            console.error('Simulation webhook failed:', response.status, await response.text());
        }
    } catch (err) {
        console.error('Error sending simulation:', err);
    }
}

// simulate a mention to trigger Grok
setTimeout(() => simulateMessage('Viewer123', 'Hey @GeeBot, how are you doing today?'), 2000);
setTimeout(() => simulateMessage('AlexStream', 'GeeBot, tell me a joke!'), 8000);

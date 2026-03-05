/**
 * Simulates a real Kick webhook 'chat.message.sent' event to test GeeBot locally.
 * Bypasses signature verification — only use for local development.
 */
async function simulateMessage(username: string, content: string, broadcasterUserId = 98951740) {
    console.log(`[Simulation] Sending message from ${username}: "${content}"`);

    // This matches Kick's actual webhook payload structure
    const payload = {
        event: 'chat.message.sent',
        data: {
            id: 'sim_' + Date.now(),
            broadcaster: {
                user_id: broadcasterUserId,
                username: 'gee-bot',
                slug: 'gee-bot'
            },
            sender: {
                user_id: 12345,
                username: username,
                slug: username.toLowerCase()
            },
            content: content,
            emotes: []
        }
    };

    try {
        // Note: this bypasses signature verification since it's a local simulation
        const response = await fetch('http://localhost:3000/webhook/kick', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Fake headers to pass the signature check — modify verifyKickSignature to skip in dev if needed
                'kick-event-signature': 'simulation',
                'kick-event-message-id': 'sim-' + Date.now(),
                'kick-event-message-timestamp': new Date().toISOString()
            },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log('[Simulation] Webhook delivered successfully.');
        } else {
            console.error('[Simulation] Webhook failed:', response.status, await response.text());
        }
    } catch (err) {
        console.error('[Simulation] Error:', err);
    }
}

// Simulate a mention to trigger Grok AI
setTimeout(() => simulateMessage('Viewer123', 'Hey @GeeBot, how are you doing today?'), 2000);
setTimeout(() => simulateMessage('AlexStream', 'GeeBot, tell me a joke!'), 8000);

import dotenv from 'dotenv';
dotenv.config();

const CLIENT_ID = process.env.KICK_API_CLIENT_ID;
const CLIENT_SECRET = process.env.KICK_API_CLIENT_SECRET;

let currentAccessToken: string | null = null;
let tokenExpiryTimestamp: number = 0;

/**
 * Fetches an Access Token using the Client Credentials grant
 * from Kick's official OAuth server.
 */
export async function getAccessToken(): Promise<string> {
    if (currentAccessToken && Date.now() < tokenExpiryTimestamp) {
        return currentAccessToken;
    }

    try {
        console.log('Fetching new Kick Access Token...');
        const authHeader = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const response = await fetch('https://id.kick.com/oauth/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${authHeader}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials'
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch access token: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const data = await response.json();

        currentAccessToken = data.access_token;
        // Data usually has expires_in in seconds. Buffer by 60 seconds.
        const expiresInMs = (data.expires_in - 60) * 1000;
        tokenExpiryTimestamp = Date.now() + expiresInMs;

        console.log('Successfully acquired Kick Access Token!');
        return currentAccessToken as string;

    } catch (error) {
        console.error('Error in getAccessToken:', error);
        throw error;
    }
}

// Exchange Auth Code + PKCE Verifier for a User Access Token
export async function exchangeCodeForToken(code: string, verifier: string) {
    const clientId = process.env.KICK_API_CLIENT_ID;
    const clientSecret = process.env.KICK_API_CLIENT_SECRET;

    // Redirect URI must match the authorize request exactly.
    // Use an environment variable for dynamic host (e.g., ngrok) or default to localhost.
    const redirectUri = process.env.KICK_REDIRECT_URI || `http://localhost:3000/auth/kick/callback`;

    const response = await fetch('https://id.kick.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId!,
            client_secret: clientSecret!,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri,
            code_verifier: verifier
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Token exchange failed: ${response.status} ${errText}`);
    }

    return await response.json() as { access_token: string, refresh_token: string };
}

// Get information about the user who just authorized
export async function getAuthenticatedUser(accessToken: string) {
    const response = await fetch('https://api.kick.com/public/v1/users', {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch user info: ${response.status}`);
    }

    const data = await response.json() as any;

    return {
        user_id: data.data.id,
        username: data.data.username,
        channel_id: data.data.channel?.id || data.data.id
    };
}

// Search for a channel by its name/slug to get its ID
export async function getChannelInfo(slug: string) {
    const token = await getAccessToken();
    const response = await fetch(`https://api.kick.com/public/v1/channels?slug=${slug}`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch channel info: ${response.status} ${await response.text()}`);
    }

    return await response.json();
}

/**
 * Sends a message to a channel's chat room.
 */
export async function sendChatMessage(channelId: string, message: string) {
    const token = await getAccessToken();
    const response = await fetch(`https://api.kick.com/public/v1/chat`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            content: message,
            type: 'bot', // Standard for bot messages
            channel_id: channelId
        })
    });

    if (!response.ok) {
        throw new Error(`Failed to send chat message: ${response.status} ${await response.text()}`);
    }

    return await response.json();
}

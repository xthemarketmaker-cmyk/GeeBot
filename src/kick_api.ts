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
    // Kick's API endpoints can be fluid. We will probe the known endpoints
    const endpointsToTry = [
        'https://id.kick.com/api/v1/user',
        'https://kick.com/api/v1/user',
        'https://api.kick.com/public/v1/users',
        'https://api.kick.com/public/v1/user',
        'https://api.kick.com/v1/user'
    ];

    let lastErrorText = '';

    for (const url of endpointsToTry) {
        try {
            console.log(`[OAuth Search] Trying to fetch user info from: ${url}`);
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json() as any;
                console.log(`[OAuth Search] SUCCESS on ${url}:`, JSON.stringify(data).substring(0, 300));

                // Handle both wrapped { data: { id: ... } } and flat { id: ... } structures
                const payload = data.data || data;

                // Make sure we actually have an ID before declaring success
                const id = payload?.id || payload?.user_id || payload?.sub;

                if (id) {
                    return {
                        user_id: id.toString(),
                        username: payload?.username || payload?.name || 'Unknown',
                        channel_id: payload?.channel?.id || payload?.channel_id || id.toString()
                    };
                } else {
                    console.log(`[OAuth Search] Got 200 OK from ${url} but no user ID found in payload.`);
                }
            } else {
                console.log(`[OAuth Search] FAILED on ${url} with status ${response.status}`);
            }
        } catch (err: any) {
            console.error(`[OAuth Search] Network error on ${url}:`, err.message);
        }
    }

    throw new Error('Failed to fetch user data from any known Kick endpoints. They may have updated their API structure.');
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

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
export async function exchangeCodeForToken(code: string, verifier: string, dynamicRedirectUri?: string) {
    const clientId = process.env.KICK_API_CLIENT_ID;
    const clientSecret = process.env.KICK_API_CLIENT_SECRET;

    // Redirect URI must match the authorize request exactly.
    // Use the dynamic origin passed from the frontend (Railway url), or fallback to localhost.
    const redirectUri = dynamicRedirectUri || process.env.KICK_REDIRECT_URI || `http://localhost:3000/auth/kick/callback`;

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

// Refresh an expired User Access Token
export async function refreshUserToken(refreshToken: string) {
    const clientId = process.env.KICK_API_CLIENT_ID;
    const clientSecret = process.env.KICK_API_CLIENT_SECRET;

    const response = await fetch('https://id.kick.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId!,
            client_secret: clientSecret!,
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Token refresh failed: ${response.status} ${errText}`);
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
                let payload = data.data || data;

                // CRITICAL FIX: The /public/v1/users endpoint returns an array of users inside `data`!
                if (Array.isArray(payload)) {
                    payload = payload[0];
                }

                // Make sure we actually have an ID before declaring success
                const id = payload?.id || payload?.user_id || payload?.sub;

                if (id) {
                    return {
                        user_id: id.toString(),
                        username: payload?.username || payload?.name || 'Unknown',
                        // Sometimes the API gives us `channel_id` directly, other times just the user ID which works too
                        channel_id: payload?.channel_id || payload?.channel?.id || id.toString(),
                        chatroom_id: payload?.chatroom?.id // Extract chatroom ID if present in the payload
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
 *
 * @param broadcasterUserId - The numeric user ID of the channel to post in (broadcaster_user_id from Kick API)
 * @param message - The message content to send
 * @param userToken - A User Access Token with chat:write scope. Should be the bot account's own token.
 *                    If omitted, falls back to the App Access Token (which will fail for chat — for debugging only).
 */
export async function sendChatMessage(broadcasterUserId: string | number, message: string, userToken?: string) {
    // The Kick API requires a User Access Token with chat:write scope to send messages.
    // The App Access Token (Client Credentials) does NOT have permission to send chat messages.
    // userToken should be the bot account's (gee-bot) own OAuth token.
    const token = userToken || await getAccessToken();

    const payload = {
        content: message,
        type: 'bot',
        broadcaster_user_id: parseInt(broadcasterUserId.toString(), 10)
    };

    console.log(`[Kick API] Sending chat message to broadcaster ID: ${broadcasterUserId} | Token Prefix: ${token.substring(0, 15)}...`);
    console.log(`[Kick API] Payload:`, JSON.stringify(payload));

    const response = await fetch('https://api.kick.com/public/v1/chat', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error(`[Kick API] REJECTED (Status ${response.status}): ${errText}`);
        throw new Error(`Failed to send chat message: ${response.status} ${errText}`);
    }

    return await response.json();
}

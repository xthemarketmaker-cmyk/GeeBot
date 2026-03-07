const socket = io();

// Tab Switching Logic
const navItems = document.querySelectorAll('.nav-item');
const tabContents = document.querySelectorAll('.tab-content');
const tabTitle = document.getElementById('current-tab-title');

navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = item.getAttribute('data-tab');

        // Update active class on nav
        navItems.forEach(i => i.classList.remove('active'));
        item.classList.add('active');

        // Show corresponding tab
        tabContents.forEach(content => {
            content.classList.remove('active');
            if (content.id === `${tab}-tab`) {
                content.classList.add('active');
                tabTitle.innerText = item.innerText.trim().split(' ').pop();
            }
        });
    });
});

// Live Chat Feed Integration
const chatFeed = document.getElementById('chat-feed');

socket.on('chatMessage', (data) => {
    // Remove placeholder if it exists
    const placeholder = chatFeed.querySelector('.placeholder');
    if (placeholder) placeholder.remove();

    const msgElement = document.createElement('div');
    msgElement.className = 'chat-msg';
    msgElement.innerHTML = `
        <span class="msg-user">${data.sender}:</span>
        <span class="msg-content">${data.content}</span>
    `;

    chatFeed.insertBefore(msgElement, chatFeed.firstChild);

    // Limit to last 50 messages
    if (chatFeed.children.length > 50) {
        chatFeed.removeChild(chatFeed.lastChild);
    }
});

// Helper for PKCE
function generateRandomString(length) {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let result = '';
    const values = crypto.getRandomValues(new Uint8Array(length));
    for (let i = 0; i < length; i++) {
        result += charset[values[i] % charset.length];
    }
    return result;
}

async function generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// Link Channel Action
const linkBtn = document.getElementById('link-channel-btn');
if (linkBtn) {
    linkBtn.addEventListener('click', async () => {
        const clientId = '01KJYGD33HSJ3CNMJFK7GRZ2D8'; // Your App Client ID
        const state = generateRandomString(32);
        const verifier = generateRandomString(64);
        const challenge = await generateCodeChallenge(verifier);

        // Save to session to verify on return
        sessionStorage.setItem('kick_oauth_state', state);
        sessionStorage.setItem('kick_oauth_verifier', verifier);

        // Redirect URL must match the Developer Portal exactly
        const redirectUri = encodeURIComponent(`${window.location.origin}/auth/kick/callback`);
        const scope = encodeURIComponent('user:read channel:read chat:write events:subscribe');

        const authUrl = `https://id.kick.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;

        console.log('Redirecting to Kick Auth:', authUrl);
        window.location.href = authUrl;
    });
}

// --- REFINED SETTINGS & AUTOMATION LOGIC ---
const botToggle = document.getElementById('bot-enabled-toggle');
const aiToggle = document.getElementById('ai-enabled-toggle');
const gamesToggle = document.getElementById('games-enabled-toggle');
const adsToggle = document.getElementById('ads-enabled-toggle');
const togglesBtn = document.getElementById('save-toggles-btn');

// Ad elements
const adList = document.getElementById('ad-list');
const adContent = document.getElementById('ad-content');
const adInterval = document.getElementById('ad-interval');
const addAdBtn = document.getElementById('add-ad-btn');

// Use a simple prompt for channel ID for now, or default to __bot__
let currentChannelId = sessionStorage.getItem('current_channel_id') || '__bot__';
let currentToken = sessionStorage.getItem('dashboard_token') || '';

// Auth Headers Generator
function getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (currentToken) {
        headers['Authorization'] = `Bearer ${currentToken}`;
    }
    return headers;
}

// Save Toggles
if (togglesBtn) {
    togglesBtn.addEventListener('click', async () => {
        const settings = {
            channelId: currentChannelId,
            bot_enabled: botToggle.checked.toString(),
            ai_enabled: aiToggle.checked.toString(),
            games_enabled: gamesToggle.checked.toString(),
            ads_enabled: adsToggle.checked.toString()
        };

        try {
            const resp = await fetch('/api/settings', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify(settings)
            });
            if (resp.ok) showToast("Modules Updated Successfully!");
        } catch (err) {
            console.error('Toggle save failed:', err);
        }
    });
}

// Ads Management
async function loadAds() {
    try {
        const resp = await fetch(`/api/ads?channelId=${currentChannelId}`, {
            headers: getAuthHeaders()
        });
        const ads = await resp.json();
        adList.innerHTML = '';

        if (ads.length === 0) {
            adList.innerHTML = '<p class="placeholder">No scheduled ads yet.</p>';
            return;
        }

        ads.forEach(ad => {
            const adItem = document.createElement('div');
            adItem.className = 'ad-item glass';
            adItem.innerHTML = `
                <div>
                    <p class="ad-text">"${ad.content}"</p>
                    <small>Interval: ${ad.interval_minutes} minutes</small>
                </div>
                <button class="btn btn-danger btn-sm" onclick="deleteAd(${ad.id})">Delete</button>
            `;
            adList.appendChild(adItem);
        });
    } catch (err) {
        console.error('Failed to load ads:', err);
    }
}

if (addAdBtn) {
    addAdBtn.addEventListener('click', async () => {
        const content = adContent.value;
        const interval = adInterval.value;

        if (!content) return showToast("Please enter ad content!");

        try {
            const resp = await fetch('/api/ads', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({
                    channelId: currentChannelId,
                    content,
                    interval_minutes: parseInt(interval)
                })
            });
            if (resp.ok) {
                adContent.value = '';
                showToast("Ad Scheduled!");
                loadAds();
            }
        } catch (err) {
            console.error('Add ad failed:', err);
        }
    });
}

window.deleteAd = async (id) => {
    try {
        const resp = await fetch(`/api/ads/${id}?channelId=${currentChannelId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (resp.ok) {
            showToast("Ad Deleted.");
            loadAds();
        }
    } catch (err) {
        console.error('Delete ad failed:', err);
    }
};

// UI Actions - Main Settings
const aiPersonality = document.getElementById('ai-personality');
const aiProbability = document.getElementById('ai-probability');
const toast = document.getElementById('toast');
const saveBtn = document.getElementById('save-ai-settings');

if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
        const settings = {
            channelId: currentChannelId,
            ai_personality: aiPersonality.value,
            ai_probability: aiProbability.value
        };

        try {
            const resp = await fetch('/api/settings', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify(settings)
            });
            if (resp.ok) {
                showToast("AI Brain Updated Successfully!");
            }
        } catch (err) {
            console.error('Save failed:', err);
            showToast("Error saving settings.");
        }
    });
}

function showToast(message) {
    toast.innerText = message;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Fetch initial settings
async function loadSettings() {
    try {
        const resp = await fetch(`/api/settings?channelId=${currentChannelId}`, {
            headers: getAuthHeaders()
        });
        const settings = await resp.json();

        if (settings.ai_personality) aiPersonality.value = settings.ai_personality;
        if (settings.ai_probability) aiProbability.value = settings.ai_probability;
        if (settings.bot_enabled) botToggle.checked = settings.bot_enabled === 'true';
        if (settings.ai_enabled) aiToggle.checked = settings.ai_enabled === 'true';
        if (settings.games_enabled) gamesToggle.checked = settings.games_enabled === 'true';
        if (settings.ads_enabled) adsToggle.checked = settings.ads_enabled === 'true';

        loadAds();
    } catch (err) {
        console.error('Failed to load settings:', err);
    }
}

loadSettings();

// Copy URL buttons
document.querySelectorAll('.copy-url').forEach(btn => {
    btn.addEventListener('click', () => {
        const path = btn.getAttribute('data-url');
        const fullUrl = `${window.location.origin}${path}`;

        navigator.clipboard.writeText(fullUrl).then(() => {
            showToast("Copied to Clipboard!");
        });
    });
});

// Mock stats update
function updateStats() {
    // Keep internal dashboard live loop if needed
}
updateStats();

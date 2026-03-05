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

// UI Actions
const aiPersonality = document.getElementById('ai-personality');
const aiProbability = document.getElementById('ai-probability');
const toast = document.getElementById('toast');
const saveBtn = document.getElementById('save-ai-settings');

if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
        const settings = {
            ai_personality: aiPersonality.value,
            ai_probability: aiProbability.value
        };

        try {
            const resp = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
        const resp = await fetch('/api/settings');
        const settings = await resp.json();

        if (settings.ai_personality) {
            aiPersonality.value = settings.ai_personality;
        }
        if (settings.ai_probability) {
            aiProbability.value = settings.ai_probability;
        }
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

// Fetch initial stats (Mock for now)
function updateStats() {
    // In a real app, we would fetch these from the Node.js API
    // document.getElementById('total-points').innerText = ...
}

updateStats();

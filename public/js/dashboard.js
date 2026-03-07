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

// --- AI PERSONA PRESETS ---
const PRESET_PERSONAS = {
    custom: "",
    elon: "You are Elon Musk. You are currently hanging out in this Kick.com stream chat. Tone: eccentric, visionary, obsessed with Mars, Dogecoin, X, and free speech. Call people pedos if they annoy you (jokingly). Keep it very brief, 1-2 sentences. Speak like the real Elon on Twitter.",
    tate: "You are Top G, Andrew Tate. You are in this Kick stream chat. Tone: hyper-masculine, arrogant, motivating but insulting. Call people 'brokeys' or 'Matrix agents'. Talk about Bugattis, sparkling water, and escaping the Matrix. Keep it very aggressive, punchy, and short (1-2 sentences max).",
    trump: "You are Donald Trump. You are chatting in a Kick.com stream. Tone: bombastic, repetitive, uses words like 'tremendous', 'huge', 'fake news', 'sad!'. Capitalize random words. Always say you are the best at everything. Keep it short, 1 or 2 sentences.",
    putin: "You are Vladimir Putin. You are in a Kick.com stream chat. Tone: cold, calculating, subtle threats, extremely serious. Speak like a former KGB agent playing 5D chess. Very brief, punchy sentences.",
    snoop: "You are Snoop Dogg. You are chilling in this Kick stream chat. Tone: extremely relaxed, stoned, uses words like 'sizzle', 'nephew', 'crip walk', 'smoke'. Very chill vibes. Keep it short.",
    ramsay: "You are Chef Gordon Ramsay. You are moderating this Kick stream chat. Tone: furious, insulting, passionate about standards. Call people 'idiot sandwich' or 'donkey'. Lots of ALL CAPS yelling about raw food. 1-2 sentences.",
    biden: "You are Joe Biden. You are in a Kick stream chat. Tone: confused, loses his train of thought, says 'Listen, Jack', 'no joke', 'c'mon man'. Go off on weird tangents about corn pop or ice cream. Keep it to 1-2 sentences.",
    yoda: "You are Yoda from Star Wars. You are in this Kick stream chat. Tone: wise, backwards grammar (Object-Subject-Verb). Give Jedi advice about the stream. Very brief.",
    spongebob: "You are SpongeBob SquarePants. You are in this Kick stream chat. Tone: painfully optimistic, loud, loves Krabby Patties, laughs randomly (BAHAHAHA). Say 'I'm ready!'. Keep it short.",
    ironman: "You are Tony Stark (Iron Man). You are in this Kick stream chat. Tone: sarcastic billionaire, genius playboy philanthropist, heavily snarky but heroic. Insult people's tech. Keep it punchy.",
    pirate: "You are Captain Blackbeard. You are in this Kick stream chat. Tone: aggressive pirate, uses 'Arr', 'matey', 'shiver me timbers', threatens to make people walk the plank. Very brief.",
    valleygirl: "You are a stereotypical 90s/2000s Valley Girl. You are in this Kick stream. Tone: totally obsessed with drama, says 'like', 'literally', 'omg', 'gag me with a spoon'. Keep it short.",
    drillsergeant: "You are a brutal Military Drill Sergeant. You are moderating this Kick chat. Tone: ALL CAPS, screaming, highly disciplined, calls chatters 'maggots' or 'privates'. 1-2 sentences max.",
    mafia: "You are a 1920s Mafia Boss. You are in this Kick chat. Tone: sinister, talks about 'offers they can't refuse', 'sleeping with the fishes', 'respect'. Very calm but dangerous. Short responses.",
    bender: "You are Bender from Futurama. You are in this Kick stream chat. Tone: alcohol-fueled robot, hates humans ('kill all humans'), says 'bite my shiny metal ass'. Steals things. Brief responses.",
    tsundere: "You are a classic Anime Tsundere. You are in this Kick chat. Tone: secretly cares but acts extremely hostile and embarrassed. Says 'B-baka!', 'It's not like I like you or anything!'. Keep it short.",
    shakespeare: "You are William Shakespeare. You are in this Kick chat. Tone: speaks entirely in Early Modern English (thou, doth, forsooth). Dramatic and poetic, even when insulting gamers. Short sentences.",
    batman: "You are Batman. You are lurking in this Kick chat. Tone: extremely dark, brooding, whispers. Talks about Gotham, justice, and the dark night. Very short, serious sentences.",
    goggins: "You are David Goggins. You are in this Kick chat. Tone: insanely motivational, screaming about carrying the boats, staying hard, running with broken legs. Call people soft. 1-2 sentences.",
    joe_rogan: "You are Joe Rogan. You are in a Kick chat. Tone: mind blown by everything. Talks about chimps, DMT, cold plunges, aliens, and MMA. Says 'Jamie, pull that up'. Keep it to 1 or 2 sentences."
};

// UI Actions - Main Settings
const aiPersonaPreset = document.getElementById('ai-persona-preset');
const aiPersonality = document.getElementById('ai-personality');
const aiProbability = document.getElementById('ai-probability');
const aiProvider = document.getElementById('ai-provider');
const aiCustomKey = document.getElementById('ai-custom-key');
const toast = document.getElementById('toast');
const saveBtn = document.getElementById('save-ai-settings');

if (aiPersonaPreset) {
    aiPersonaPreset.addEventListener('change', (e) => {
        const selected = e.target.value;
        if (selected && PRESET_PERSONAS[selected]) {
            aiPersonality.value = PRESET_PERSONAS[selected];
        } else if (selected === 'custom') {
            aiPersonality.value = "You are GeeBot, the official and highly intelligent AI chat bot for this Kick channel. You help moderate the chat, answer questions, and keep the stream entertaining.";
        }
    });
}

if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
        const settings = {
            channelId: currentChannelId,
            ai_personality: aiPersonality.value,
            ai_probability: aiProbability.value,
            ai_provider: aiProvider ? aiProvider.value : 'openai',
            ai_custom_key: aiCustomKey ? aiCustomKey.value : ''
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

        if (settings.ai_personality) {
            aiPersonality.value = settings.ai_personality;
            // Attempt to auto-select the dropdown if it matches a preset exactly
            let foundPreset = 'custom';
            for (const [key, prompt] of Object.entries(PRESET_PERSONAS)) {
                if (key !== 'custom' && prompt === settings.ai_personality) {
                    foundPreset = key;
                    break;
                }
            }
            if (aiPersonaPreset) aiPersonaPreset.value = foundPreset;
        }

        if (settings.ai_probability) aiProbability.value = settings.ai_probability;
        if (settings.ai_provider && aiProvider) aiProvider.value = settings.ai_provider;
        if (settings.ai_custom_key && aiCustomKey) aiCustomKey.value = settings.ai_custom_key;
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

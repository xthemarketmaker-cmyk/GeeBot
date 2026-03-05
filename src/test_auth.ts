import { getAccessToken } from './kick_api';

async function testConfig() {
    console.log('Testing Kick Account Credentials...');
    try {
        const token = await getAccessToken();
        console.log('SUCCESS! Token retrieved:', token.substring(0, 10) + '...');

        // Let's try to fetch some public data using this token for a known channel
        console.log('Testing API call (Fetching channel info for trainwreckstv)...');
        const knownChannel = 'trainwreckstv';

        // 1. Try v1/channels?slug=
        const resp1 = await fetch(`https://api.kick.com/v1/channels?slug=${knownChannel}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log('Try v1/channels?slug= result:', resp1.status);

        // 2. Try public/v1/channels?slug=
        const resp2 = await fetch(`https://api.kick.com/public/v1/channels?slug=${knownChannel}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log('Try public/v1/channels?slug= result:', resp2.status);

        if (resp1.ok) {
            const data = await resp1.json();
            console.log('API SUCCESS! Data:', JSON.stringify(data).substring(0, 100));
        } else if (resp2.ok) {
            const data = await resp2.json();
            console.log('API SUCCESS! Data:', JSON.stringify(data).substring(0, 100));
        } else {
            console.error('API CALL FAILED for both attempts:');
            console.error('V1 Status:', resp1.status, await resp1.text());
            console.error('Public V1 Status:', resp2.status, await resp2.text());
        }

    } catch (e: any) {
        console.error('FAILED:');
        console.error(e);
    }
}

testConfig();

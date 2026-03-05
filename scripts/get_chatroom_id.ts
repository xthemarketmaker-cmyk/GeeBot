import { chromium } from 'playwright';

async function getChatroomId(slug: string) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    console.log(`Navigating to https://kick.com/${slug}...`);

    try {
        // We listen for the specific API request that returns channel/chatroom data
        let chatroomId: string | null = null;

        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('/api/v1/channels/') && response.status() === 200) {
                try {
                    const json = await response.json();
                    if (json.chatroom && json.chatroom.id) {
                        chatroomId = json.chatroom.id.toString();
                        console.log(`Found Chatroom ID in network request: ${chatroomId}`);
                    }
                } catch (e) {
                    // Ignore parse errors from other requests
                }
            }
        });

        await page.goto(`https://kick.com/${slug}`, { waitUntil: 'networkidle', timeout: 60000 });

        // Fallback: Check for script tags if network interception missed it
        if (!chatroomId) {
            console.log('Checking page content for ID...');
            const content = await page.content();
            const match = content.match(/chatroom_id":(\d+)/) || content.match(/"id":(\d+),"chatable_type/);
            if (match) {
                chatroomId = match[1];
                console.log(`Found Chatroom ID in page content: ${chatroomId}`);
            }
        }

        if (chatroomId) {
            console.log(`RESULT_ID: ${chatroomId}`);
        } else {
            console.log('Could not find chatroom ID.');
        }

    } catch (err) {
        console.error('Error during extraction:', err);
    } finally {
        await browser.close();
    }
}

const slug = process.argv[2] || 'gee_bot';
getChatroomId(slug);

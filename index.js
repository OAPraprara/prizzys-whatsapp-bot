require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const { 
    default: makeWASocket, 
    DisconnectReason, 
    BufferJSON, 
    initAuthCreds,
    proto,
    Browsers,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode'); // Changed this!
const pino = require('pino');

const app = express();
app.use(express.json());

const MONGO_URL = process.env.MONGO_URL;
let sock; 
let mongoClient; 
let qrCodeData = null; // Holds the live QR code image

// ---------------------------------------------------------
// Custom MongoDB Auth State Adapter
// ---------------------------------------------------------
async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => {
        return collection.replaceOne({ _id: id }, JSON.parse(JSON.stringify(data, BufferJSON.replacer)), { upsert: true });
    };
    const readData = async (id) => {
        try {
            const data = await collection.findOne({ _id: id });
            return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
        } catch (error) {
            return null;
        }
    };
    const removeData = async (id) => {
        try {
            await collection.deleteOne({ _id: id });
        } catch (_a) {}
    };
    
    const creds = await readData('creds') || initAuthCreds();
    
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        }
    };
}

// ---------------------------------------------------------
// Core WhatsApp Connection Logic
// ---------------------------------------------------------
async function connectToWhatsApp() {
    if (!mongoClient) {
        console.log("Connecting to MongoDB...");
        mongoClient = new MongoClient(MONGO_URL);
        await mongoClient.connect();
        console.log("MongoDB connected successfully!");
    }
    
    const collection = mongoClient.db('prizzys_wa').collection('auth_state');
    const { state, saveCreds } = await useMongoDBAuthState(collection);

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
        logger: pino({ level: 'info' }) 
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // If a new QR code is generated, convert it to an image URL
        if (qr) {
            console.log("\nNew QR Code generated! Go to /qr to scan it.");
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) {
                    qrCodeData = url;
                }
            });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to error:', lastDisconnect.error?.message || lastDisconnect.error);
            console.log('Reconnecting:', shouldReconnect);
            
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 5000); 
            } else {
                console.log('Logged out. Please drop the MongoDB collection to generate a new QR code.');
                qrCodeData = null; // Clear QR if logged out completely
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connection successfully opened!');
            qrCodeData = null; // Clear the QR code from memory once connected!
        }
    });
}

// ---------------------------------------------------------
// Express Web Routes
// ---------------------------------------------------------

// 1. Webhook Endpoint for Google Forms
app.post('/send-message', async (req, res) => {
    const { name, phone } = req.body;
    
    if (!name || !phone) {
        return res.status(400).json({ error: "Missing name or phone" });
    }

    try {
        const jid = `${phone}@s.whatsapp.net`;
        const message = `Hi ${name}. This is just to let you know your Prizzys order was received. The details were sent to your Gmail. TY!`;

        await sock.sendMessage(jid, { text: message });
        res.status(200).json({ success: true, message: "WhatsApp message sent!" });
    } catch (error) {
        console.error("Failed to send message:", error);
        res.status(500).json({ error: "Failed to send message" });
    }
});

// 2. Visual QR Code Endpoint
app.get('/qr', (req, res) => {
    if (!qrCodeData) {
        return res.send(`
            <h2 style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                No QR code available right now.<br><br>
                The bot is either already connected to WhatsApp, or it is still loading.
            </h2>
            <script>setTimeout(() => location.reload(), 3000);</script>
        `);
    }

    res.send(`
        <html>
            <head><title>Prizzys QR Scanner</title></head>
            <body style="display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f0f0f0; font-family: sans-serif;">
                <div style="text-align: center; background: white; padding: 2rem; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                    <h2>Link Prizzys WhatsApp</h2>
                    <img src="${qrCodeData}" alt="QR Code" style="width: 300px; height: 300px;" />
                    <p style="color: #666;">This page will auto-refresh every 5 seconds.</p>
                </div>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    connectToWhatsApp();
});
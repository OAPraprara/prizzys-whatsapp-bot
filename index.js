require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const { 
    default: makeWASocket, 
    DisconnectReason, 
    BufferJSON, 
    initAuthCreds,
    proto,
    Browsers
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode'); 
const pino = require('pino');

const app = express();
app.use(express.json());

const MONGO_URL = process.env.MONGO_URL;
let sock; 
let mongoClient; 
let qrCodeData = null; 
let isConnected = false; 

// ---------------------------------------------------------
// Custom MongoDB Auth State Adapter (Safe Wrapper)
// ---------------------------------------------------------
async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => {
        const payload = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        return collection.replaceOne(
            { _id: id }, 
            { _id: id, data: payload }, 
            { upsert: true }
        );
    };
    
    const readData = async (id) => {
        try {
            const doc = await collection.findOne({ _id: id });
            return doc && doc.data ? JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver) : null;
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

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'), 
        logger: pino({ level: 'info' }), // TURNED LOGS BACK ON
        syncFullHistory: false,      
        markOnlineOnConnect: true,  
        generateHighQualityLinkPreviews: false 
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("\nNew QR Code generated! Go to /qr to scan it.");
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) qrCodeData = url;
            });
        }

        if (connection === 'close') {
            isConnected = false; 
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log('Connection closed. Status code:', statusCode);
            
            if (shouldReconnect) {
                console.log('Reconnecting in 5 seconds...');
                setTimeout(() => connectToWhatsApp(), 5000); 
            } else {
                console.log('Logged out from phone! Please go to /reset to clear the database.');
                qrCodeData = null; 
            }
        } else if (connection === 'open') {
            isConnected = true; 
            qrCodeData = null; 
            console.log('\n✅ WhatsApp is OPEN and ready for webhooks!');
        }
    });
}

// ---------------------------------------------------------
// Express Web Routes
// ---------------------------------------------------------
app.use((req, res, next) => {
    console.log(`\n[${new Date().toLocaleTimeString()}] 📬 Incoming Request: ${req.method} ${req.path}`);
    next();
});

app.post('/send-message', async (req, res) => {
    console.log("Payload from Google Form:", req.body);
    const { name, phone } = req.body;
    
    if (!name || !phone) {
        return res.status(400).json({ error: "Missing name or phone" });
    }

    try {
        let attempts = 0;
        while (!isConnected && attempts < 10) {
            console.log(`WhatsApp not open yet. Waiting... (Attempt ${attempts + 1}/10)`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            attempts++;
        }

        if (!isConnected) {
            return res.status(503).json({ error: "WhatsApp not ready" });
        }

        const jid = `${phone}@s.whatsapp.net`;
        const message = `Hi ${name}. This just to let you know your prizzys order was received. The details was sent to your gmail. TY`;

        await sock.sendMessage(jid, { text: message });
        res.status(200).json({ success: true, message: "WhatsApp message sent!" });
        console.log(`✅ Message successfully sent to ${phone}`);
    } catch (error) {
        console.error("❌ Failed to send message:", error);
        res.status(500).json({ error: "Failed to send message" });
    }
});

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

// THE MAGIC RESET BUTTON
app.get('/reset', async (req, res) => {
    try {
        if (mongoClient) {
            await mongoClient.db('prizzys_wa').collection('auth_state').drop();
        }
        res.send("Database wiped! Render is restarting the server to generate a new QR code. Wait 10 seconds, then go to /qr");
        console.log("Manual reset triggered. Crashing app to force Render restart...");
        process.exit(1); 
    } catch (e) {
        res.send("Database is already empty. Restarting server... go to /qr");
        process.exit(1);
    }
});

// ---------------------------------------------------------
// Boot Sequence
// ---------------------------------------------------------
async function startApp() {
    console.log("Starting server boot sequence...");
    await connectToWhatsApp(); 
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server running and listening for webhooks on port ${PORT}`);
    });
}

startApp();
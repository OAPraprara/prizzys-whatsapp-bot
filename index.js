require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const { 
    default: makeWASocket, 
    DisconnectReason, 
    BufferJSON, 
    initAuthCreds,
    proto
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const app = express();
app.use(express.json());

const MONGO_URL = process.env.MONGO_URL;
let sock; 
let mongoClient; // Keeps the DB connection global so we don't spam MongoDB

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
    // Only connect to MongoDB once!
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
        // Spoofing a standard Chrome browser prevents Meta from instantly dropping the connection
        browser: ["PrizzysBot", "Chrome", "20.0.04"],
        // Set to 'info' so Render logs will show us exactly why it crashes if it fails again
        logger: pino({ level: 'info' }) 
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("\n=======================================================");
            console.log("Scan this QR code to link your Prizzys WhatsApp:");
            qrcode.generate(qr, { small: true });
            console.log("=======================================================\n");
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            // This will print the exact reason Meta rejected the connection
            console.log('Connection closed due to error:', lastDisconnect.error?.message || lastDisconnect.error);
            console.log('Reconnecting:', shouldReconnect);
            
            if (shouldReconnect) {
                // Add a 5-second delay so we don't accidentally get rate-limited
                setTimeout(() => connectToWhatsApp(), 5000); 
            } else {
                console.log('You logged out from your phone. Please delete the MongoDB collection to generate a new QR code.');
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connection successfully opened!');
        }
    });
}

// ---------------------------------------------------------
// Express Webhook Endpoint
// ---------------------------------------------------------
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    connectToWhatsApp();
});
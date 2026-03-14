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

// Set this in your Render Environment Variables later
const MONGO_URL = process.env.MONGO_URL || "YOUR_MONGODB_CONNECTION_STRING";
let sock; // Global socket variable

// ---------------------------------------------------------
// Custom MongoDB Auth State Adapter
// This replaces useMultiFileAuthState to survive Render reboots
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
    console.log("Connecting to MongoDB...");
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    
    // Creates a database named "prizzys_wa" and a collection named "auth_state"
    const collection = client.db('prizzys_wa').collection('auth_state');
    const { state, saveCreds } = await useMongoDBAuthState(collection);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // We handle this manually below
        logger: pino({ level: 'silent' }) // Keeps your terminal clean
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("\nScan this QR code to link your Prizzys WhatsApp:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
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
        // Baileys requires the phone number to end with @s.whatsapp.net
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

const express = require("express")
const qrcode = require("qrcode-terminal")
const { Client, LocalAuth } = require("whatsapp-web.js")

const app = express()
app.use(express.json())

const client = new Client({

    authStrategy: new LocalAuth(),

    puppeteer: {
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox"
        ]
    }

})

client.on("qr", qr => {
    console.log("Scan this QR with WhatsApp:\n")
    qrcode.generate(qr, { small: true })
})

client.on("ready", () => {
    console.log("✅ WhatsApp bot connected")
})

client.initialize()

// Webhook endpoint
app.post("/send-message", async (req, res) => {

    try {

        const { name, phone } = req.body

        const message =
            `Hi ${name}. This just to let you know your prizzys order was received. The details was sent to your gmail. TY`

        const chatId = phone + "@c.us"

        await client.sendMessage(chatId, message)

        res.send("Message sent")

    } catch (err) {

        console.error(err)
        res.status(500).send("Error sending message")

    }

})

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
    console.log("🚀 Server running on port " + PORT)
})
// QR link runner for testing wolfsocket.
// Run: npx tsx ./Example/qr-link.ts
// Scan the printed QR (or baileys_auth_info/qr.png) with WhatsApp:
//   WhatsApp > Settings > Linked devices > Link a device
// Session is stored in baileys_auth_info/ (gitignored) and is NEVER
// cleared by this script. Do not delete that folder until Briton says so.
import { Boom } from '@hapi/boom'
import { writeFileSync } from 'node:fs'
import QRCode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import makeWASocket, {
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState
} from '../src'
import P from 'pino'

const AUTH_DIR = 'baileys_auth_info'
const logger = P({ level: 'info' })

const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA version ${version.join('.')} (latest: ${isLatest})`)

	const sock = makeWASocket({
		version,
		logger,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger)
		}
	})

	sock.ev.on('creds.update', saveCreds)

	sock.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect, qr } = update

		if (qr) {
			console.log('\n=== SCAN THIS QR WITH WHATSAPP ===')
			qrcodeTerminal.generate(qr, { small: true })
			console.log('=== Linked devices > Link a device ===\n')
			// Save the raw string + a scannable PNG next to the session.
			// Both live inside the gitignored auth dir, never committed.
			writeFileSync(`${AUTH_DIR}/qr.txt`, qr)
			await QRCode.toFile(`${AUTH_DIR}/qr.png`, qr, { width: 512, margin: 2 })
			console.log(`QR also saved to ${AUTH_DIR}/qr.png`)
		}

		if (connection === 'open') {
			console.log(`\nCONNECTED as ${sock.user?.id ?? 'unknown'}\n`)
			writeFileSync(
				`${AUTH_DIR}/status.json`,
				JSON.stringify({ connected: true, user: sock.user?.id ?? null, at: new Date().toISOString() }, null, 2)
			)
		}

		if (connection === 'close') {
			const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
			console.log(`connection closed (status ${statusCode})`)
			// Never wipe the session here. Reconnect unless logged out.
			if (statusCode !== DisconnectReason.loggedOut) {
				console.log('reconnecting...')
				await startSock()
			} else {
				console.log('Logged out. Session files left untouched — delete baileys_auth_info/ only when Briton says so.')
			}
		}
	})

	sock.ev.on('messages.upsert', ({ messages, type }) => {
		if (type !== 'notify') return
		for (const msg of messages) {
			const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
			console.log(`message from ${msg.key.remoteJid}: ${text.slice(0, 120)}`)
		}
	})

	return sock
}

startSock()

// Normal media download test for wolfsocket.
// Usage: npx tsx ./Example/test-media-download.ts [group-jid]
// Connects with the saved session (no QR) and waits up to 10 minutes for
// any image/video/audio/document message in the group, then downloads it
// with downloadMediaMessage(msg, 'buffer', {}) and saves it under
// baileys_auth_info/. Diagnostic companion to the view-once test: if
// normal media downloads fine, the view-once failure is delivery, not
// the download path. Session is never cleared by this script.
import { Boom } from '@hapi/boom'
import { writeFileSync } from 'node:fs'
import makeWASocket, {
	downloadMediaMessage,
	extractMessageContent,
	fetchLatestBaileysVersion,
	getContentType,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
	type WAMessage
} from '../src'
import P from 'pino'

const AUTH_DIR = 'baileys_auth_info'
const logger = P({ level: 'warn' })
const GROUP_JID = process.argv[2] || '120363414160399028@g.us'
const WAIT_MS = 10 * 60_000
const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']

const extFor = (type: string, mimetype?: string | null) => {
	if (mimetype?.includes('jpeg') || mimetype?.includes('jpg')) return 'jpg'
	if (mimetype?.includes('png')) return 'png'
	if (mimetype?.includes('mp4')) return 'mp4'
	if (mimetype?.includes('ogg') || mimetype?.includes('opus')) return 'ogg'
	if (mimetype?.includes('pdf')) return 'pdf'
	if (mimetype?.includes('webp')) return 'webp'
	return { imageMessage: 'jpg', videoMessage: 'mp4', audioMessage: 'ogg', documentMessage: 'bin', stickerMessage: 'webp' }[type] || 'bin'
}

const result: Record<string, unknown> = { groupJid: GROUP_JID, at: new Date().toISOString() }
const save = () => writeFileSync(`${AUTH_DIR}/test-media-download.json`, JSON.stringify(result, null, 2))

const main = async () => {
	const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
	const { version } = await fetchLatestBaileysVersion()
	const sock = makeWASocket({
		version,
		logger,
		auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }
	})
	sock.ev.on('creds.update', saveCreds)

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('connect timed out after 90s')), 90_000)
		sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
			if (connection === 'open') {
				clearTimeout(timer)
				resolve()
			}
			if (connection === 'close') {
				const code = (lastDisconnect?.error as Boom)?.output?.statusCode
				clearTimeout(timer)
				reject(new Error(`connection closed, status ${code}`))
			}
		})
	})
	console.log(`connected as ${sock.user?.id} — waiting for any media in ${GROUP_JID} (up to 10 min)`)
	result.connectedAs = sock.user?.id

	const done = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('no media arrived within 10 minutes')), WAIT_MS)
		const seen = new Set<string>()

		const tryDownload = async (msg: WAMessage) => {
			const id = msg.key.id || ''
			if (seen.has(id)) return
			const content = extractMessageContent(msg.message)
			const type = content ? getContentType(content) : undefined
			console.log(`candidate ${id} fromMe=${msg.key.fromMe} type=${type || 'none'}`)
			if (!type || !MEDIA_TYPES.includes(type)) return
			seen.add(id)
			clearTimeout(timer)
			try {
				const buf = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer
				const media = (content as Record<string, { mimetype?: string }>)[type]
				const ext = extFor(type, media?.mimetype)
				const file = `${AUTH_DIR}/media-${id}.${ext}`
				writeFileSync(file, buf)
				result.download = { messageId: id, type, mimetype: media?.mimetype, bytes: buf.length, file }
				console.log(`DOWNLOADED ${type} ${buf.length} bytes -> ${file}`)
				save()
				resolve()
			} catch (err) {
				result.error = String((err as Error)?.message || err)
				console.error('download failed:', err)
				save()
				reject(err as Error)
			}
		}

		sock.ev.on('messages.upsert', ({ messages }) => {
			for (const msg of messages) {
				if (msg.key.remoteJid === GROUP_JID) void tryDownload(msg)
			}
		})
	})

	await done
	console.log('Media download test DONE. Session NOT cleared.')
	process.exit(0)
}

main().catch((err) => {
	result.error = String(err?.message || err)
	console.error('TEST FAILED:', err)
	save()
	process.exit(1)
})

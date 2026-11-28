// View-once download test, played-receipt variant.
// Usage: npx tsx ./Example/test-view-once-played.ts [group-jid|any]
// Hypothesis: a view-once reaches a companion only as a CIPHERTEXT stub
// and neither the PDO placeholder resend nor the retry receipt brings the
// content back (seen live 2026-11-28, four sends). WhatsApp's own clients
// fetch the media when the message is opened, so this variant sends the
// receipts an opening client would — `read`, then `played` — on the stub,
// and watches up to 3 minutes for the content to arrive as an upsert or
// update before downloading with downloadViewOnceMessage.
// Send the view-once AFTER this script is running. Session is never cleared.
import { Boom } from '@hapi/boom'
import { writeFileSync } from 'node:fs'
import makeWASocket, {
	downloadViewOnceMessage,
	extractViewOnceMedia,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
	type WAMessage
} from '../src'
import P from 'pino'

const AUTH_DIR = 'baileys_auth_info'
const logger = P({ level: 'warn' })
const GROUP_JID = process.argv[2] || '120363414160399028@g.us'
const WATCH_ALL = GROUP_JID === 'any'
const WAIT_MS = 10 * 60_000

const extFor = (mediaType: string, mimetype?: string | null) => {
	if (mimetype?.includes('jpeg') || mimetype?.includes('jpg')) return 'jpg'
	if (mimetype?.includes('png')) return 'png'
	if (mimetype?.includes('mp4')) return 'mp4'
	if (mimetype?.includes('ogg') || mimetype?.includes('opus')) return 'ogg'
	if (mimetype?.includes('pdf')) return 'pdf'
	return { image: 'jpg', video: 'mp4', audio: 'ogg', document: 'bin', ptv: 'mp4' }[mediaType] || 'bin'
}

const result: Record<string, unknown> = { groupJid: GROUP_JID, at: new Date().toISOString(), variant: 'played-receipt' }
const save = () => writeFileSync(`${AUTH_DIR}/test-view-once-played.json`, JSON.stringify(result, null, 2))

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
	console.log(`connected as ${sock.user?.id} — waiting for a view-once stub in ${WATCH_ALL ? 'any chat' : GROUP_JID} (up to 10 min)`)
	result.connectedAs = sock.user?.id

	const done = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('no view-once arrived within 10 minutes')), WAIT_MS)
		const receipted = new Set<string>()
		const downloaded = new Set<string>()

		const tryDownload = async (msg: WAMessage) => {
			const id = msg.key.id || ''
			const extracted = extractViewOnceMedia(msg.message)
			console.log(`candidate ${id} chat=${msg.key.remoteJid} fromMe=${msg.key.fromMe} stub=${(msg as { messageStubType?: number }).messageStubType ?? ''} keys=${Object.keys(msg.message || {}).join(',')} extracted=${extracted ? `${extracted.mediaType} isViewOnce=${extracted.isViewOnce}` : 'none'}`)
			if (extracted?.isViewOnce && !downloaded.has(id)) {
				downloaded.add(id)
				clearTimeout(timer)
				try {
					const buf = (await downloadViewOnceMessage(msg, 'buffer', {}, {
						logger,
						reuploadRequest: (m: WAMessage) => sock.updateMediaMessage(m)
					})) as Buffer
					const ext = extFor(extracted.mediaType, (extracted.media as { mimetype?: string }).mimetype)
					const file = `${AUTH_DIR}/view-once-${id}.${ext}`
					writeFileSync(file, buf)
					result.download = { messageId: id, mediaType: extracted.mediaType, bytes: buf.length, file }
					console.log(`DOWNLOADED ${extracted.mediaType} ${buf.length} bytes -> ${file}`)
					save()
					resolve()
				} catch (err) {
					result.error = String((err as Error)?.message || err)
					console.error('download failed:', err)
					save()
					reject(err as Error)
				}
				return
			}
			// Content-less stub: send the receipts an opening client would,
			// then keep waiting for the content to arrive.
			if (!extracted?.isViewOnce && !receipted.has(id) && (msg as { messageStubType?: number }).messageStubType === 2) {
				receipted.add(id)
				try {
					await sock.readMessages([{ remoteJid: msg.key.remoteJid!, id, participant: msg.key.participant }])
					await sock.sendReceipt(msg.key.remoteJid!, msg.key.participant, [id], 'played')
					result.receiptsSent = { messageId: id, types: ['read', 'played'] }
					console.log(`sent read + played receipts for stub ${id} — waiting for content...`)
					save()
				} catch (err) {
					console.error('receipts failed:', err)
				}
			}
		}

		sock.ev.on('messages.upsert', ({ messages }) => {
			for (const msg of messages) {
				if (WATCH_ALL || msg.key.remoteJid === GROUP_JID) void tryDownload(msg)
			}
		})
		sock.ev.on('messages.update', (updates) => {
			for (const { key, update } of updates) {
				if ((WATCH_ALL || key.remoteJid === GROUP_JID) && (update as { message?: WAMessage['message'] }).message) {
					void tryDownload({ key, message: (update as { message: WAMessage['message'] }).message } as WAMessage)
				}
			}
		})
	})

	await done
	console.log('View-once played-receipt test DONE. Session NOT cleared.')
	process.exit(0)
}

main().catch((err) => {
	result.error = String(err?.message || err)
	console.error('TEST FAILED:', err)
	save()
	process.exit(1)
})

// View-once media download test for wolfsocket.
// Usage: npx tsx ./Example/test-view-once-download.ts [group-jid]
// Connects with the saved session (no QR) and waits up to 10 minutes for
// a view-once message in the group, then downloads it with
// downloadViewOnceMessage(msg, 'buffer', {}, { logger, reuploadRequest:
// sock.updateMediaMessage }) and saves it under baileys_auth_info/.
// Send the view-once AFTER this script is running, and do NOT open it on
// the phone first — opening it there can consume it before we download.
// Session is never cleared by this script.
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
const WAIT_MS = 10 * 60_000

const extFor = (mediaType: string, mimetype?: string | null) => {
	if (mimetype?.includes('jpeg') || mimetype?.includes('jpg')) return 'jpg'
	if (mimetype?.includes('png')) return 'png'
	if (mimetype?.includes('mp4')) return 'mp4'
	if (mimetype?.includes('ogg') || mimetype?.includes('opus')) return 'ogg'
	if (mimetype?.includes('pdf')) return 'pdf'
	return { image: 'jpg', video: 'mp4', audio: 'ogg', document: 'bin', ptv: 'mp4' }[mediaType] || 'bin'
}

const result: Record<string, unknown> = { groupJid: GROUP_JID, at: new Date().toISOString() }
const save = () => writeFileSync(`${AUTH_DIR}/test-view-once-download.json`, JSON.stringify(result, null, 2))

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
	console.log(`connected as ${sock.user?.id} — waiting for a view-once in ${GROUP_JID} (up to 10 min)`)
	result.connectedAs = sock.user?.id

	const done = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('no view-once arrived within 10 minutes')), WAIT_MS)
		const seen = new Set<string>()

		const tryDownload = async (msg: WAMessage) => {
			const id = msg.key.id || ''
			const extracted = extractViewOnceMedia(msg.message)
			console.log(`candidate ${id} fromMe=${msg.key.fromMe} participant=${msg.key.participant || ''} stub=${(msg as { messageStubType?: number }).messageStubType ?? ''} keys=${Object.keys(msg.message || {}).join(',')} extracted=${extracted ? `${extracted.mediaType} isViewOnce=${extracted.isViewOnce} hasUrl=${!!extracted.media.url} hasDirectPath=${!!extracted.media.directPath} hasMediaKey=${!!extracted.media.mediaKey}` : 'none'}`)
			// A view-once can first arrive content-less (undecryptable
			// placeholder) and be re-delivered with the same id once the
			// sender's device resends it, so only mark an id seen once it
			// actually yielded view-once media.
			if (!extracted?.isViewOnce) return
			if (seen.has(id)) return
			seen.add(id)
			clearTimeout(timer)
			try {
				const buf = (await downloadViewOnceMessage(msg, 'buffer', {}, {
					logger,
					reuploadRequest: (m: WAMessage) => sock.updateMediaMessage(m)
				})) as Buffer
				const ext = extFor(extracted.mediaType, (extracted.media as { mimetype?: string }).mimetype)
				const file = `${AUTH_DIR}/view-once-${id}.${ext}`
				writeFileSync(file, buf)
				result.download = { messageId: id, mediaType: extracted.mediaType, mimetype: (extracted.media as { mimetype?: string }).mimetype, bytes: buf.length, file }
				console.log(`DOWNLOADED ${extracted.mediaType} ${buf.length} bytes -> ${file}`)
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
		// A view-once that arrives as an unavailable placeholder can be
		// filled in later via an update — retry then too.
		sock.ev.on('messages.update', (updates) => {
			for (const { key, update } of updates) {
				if (key.remoteJid === GROUP_JID && (update as { message?: WAMessage['message'] }).message) {
					void tryDownload({ key, message: (update as { message: WAMessage['message'] }).message } as WAMessage)
				}
			}
		})
	})

	await done
	console.log('View-once download test DONE. Session NOT cleared.')
	process.exit(0)
}

main().catch((err) => {
	result.error = String(err?.message || err)
	console.error('TEST FAILED:', err)
	save()
	process.exit(1)
})

// View-once download test with an Android browser identity.
// Usage: npx tsx ./Example/test-view-once-android.ts [group-jid|any]
//
// Why: Casper-Tech-ke/baileys (xspacesocket) proved view-once recovery
// works "once the connection uses an Android browser identity" — the
// unwrap/download helpers are the same as wolfsocket's, but the bot
// connects as Android, not as Mac/Chrome. Our Mac/Chrome companion got
// only CIPHERTEXT stubs for four live view-onces (2026-11-28); the
// server fans view-once media out differently per companion platform.
// This script is identical to test-view-once-download.ts except for
// `browser: Browsers.android('Chrome')` in the socket options.
// It reuses the same auth state — the identity is sent fresh at connect
// and no session files are touched. If it misbehaves, reconnect with
// the normal runner (Mac/Chrome identity) and the session is unchanged.
// Send the view-once AFTER this script is running, and don't open it on
// the phone first.
import { Boom } from '@hapi/boom'
import { writeFileSync } from 'node:fs'
import makeWASocket, {
	Browsers,
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
const BROWSER = Browsers.android('Chrome')

const extFor = (mediaType: string, mimetype?: string | null) => {
	if (mimetype?.includes('jpeg') || mimetype?.includes('jpg')) return 'jpg'
	if (mimetype?.includes('png')) return 'png'
	if (mimetype?.includes('mp4')) return 'mp4'
	if (mimetype?.includes('ogg') || mimetype?.includes('opus')) return 'ogg'
	if (mimetype?.includes('pdf')) return 'pdf'
	return { image: 'jpg', video: 'mp4', audio: 'ogg', document: 'bin', ptv: 'mp4' }[mediaType] || 'bin'
}

const result: Record<string, unknown> = { groupJid: GROUP_JID, at: new Date().toISOString(), browser: BROWSER, variant: 'android-identity' }
const save = () => writeFileSync(`${AUTH_DIR}/test-view-once-android.json`, JSON.stringify(result, null, 2))

const main = async () => {
	const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
	const { version } = await fetchLatestBaileysVersion()
	const sock = makeWASocket({
		version,
		logger,
		browser: BROWSER,
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
	console.log(`connected as ${sock.user?.id} with browser identity ${JSON.stringify(BROWSER)} — waiting for a view-once in ${WATCH_ALL ? 'any chat' : GROUP_JID} (up to 10 min)`)
	result.connectedAs = sock.user?.id

	const done = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('no view-once arrived within 10 minutes')), WAIT_MS)
		const seen = new Set<string>()

		const tryDownload = async (msg: WAMessage) => {
			const id = msg.key.id || ''
			const extracted = extractViewOnceMedia(msg.message)
			console.log(`candidate ${id} chat=${msg.key.remoteJid} fromMe=${msg.key.fromMe} stub=${(msg as { messageStubType?: number }).messageStubType ?? ''} keys=${Object.keys(msg.message || {}).join(',')} extracted=${extracted ? `${extracted.mediaType} isViewOnce=${extracted.isViewOnce} hasUrl=${!!extracted.media.url} hasDirectPath=${!!extracted.media.directPath} hasMediaKey=${!!extracted.media.mediaKey}` : 'none'}`)
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
	console.log('View-once Android-identity test DONE. Session NOT cleared.')
	process.exit(0)
}

main().catch((err) => {
	result.error = String(err?.message || err)
	console.error('TEST FAILED:', err)
	save()
	process.exit(1)
})

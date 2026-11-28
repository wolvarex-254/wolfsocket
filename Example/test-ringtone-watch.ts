// Ringtone watch: capture the phone's notification-tone settings as
// they sync to this companion, to find out (a) what the current
// global tone ids are and (b) whether a per-chat tone change syncs
// at all (there is no per-chat tone action in the protocol — this
// test proves it one way or the other).
// Usage: npx tsx ./Example/test-ringtone-watch.ts
// Then on the phone, one at a time:
//   1. Settings > Notifications > Notification tone (Messages) —
//      pick a different tone, save.
//   2. WolfSocket group > group name > Notifications > Notification
//      tone — pick a different tone, save.
// Watch this log: a global change should arrive as a
// settings.update { setting: 'settingsSync' } with the tone ids.
// A per-chat change arriving as nothing means the phone keeps
// per-chat tones local and no companion can set them.
// Events are also appended to baileys_auth_info/test-ringtone-watch.json.
import { Boom } from '@hapi/boom'
import { appendFileSync } from 'node:fs'
import makeWASocket, { fetchLatestBaileysVersion, makeCacheableSignalKeyStore, useMultiFileAuthState } from '../src'
import P from 'pino'

const AUTH_DIR = 'baileys_auth_info'
const logger = P({ level: 'warn' })
const GROUP_JID = '120363414160399028@g.us'
const OUT_FILE = `${AUTH_DIR}/test-ringtone-watch.json`

const record = (label: string, data: unknown) => {
	const line = JSON.stringify({ at: new Date().toISOString(), label, data })
	console.log(line)
	appendFileSync(OUT_FILE, `${line}\n`)
}

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
	console.log(`ringtone watch connected as ${sock.user?.id}`)
	console.log('Now change the tones on the phone (see the file header). Waiting for settings to sync...')

	sock.ev.on('settings.update', update => {
		record('settings.update', update)
	})

	sock.ev.on('chats.update', updates => {
		for (const update of updates) {
			if (update.id === GROUP_JID) {
				record('chats.update[group]', update)
			}
		}
	})
}

main().catch(err => {
	console.error('WATCH FAILED:', err)
	process.exit(1)
})

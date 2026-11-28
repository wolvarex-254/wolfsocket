// Chat theme test: colour scheme + custom wallpaper on the WolfSocket
// group, then a colour scheme on the DM with the second account.
// Usage: npx tsx ./Example/test-chat-theme.ts [group-jid] [dm-jid]
//
// What it does, in order:
//   1. setGroupColorScheme(group, 'Royal-Blue@Tonal', everyone)
//   2. setGroupWallpaper(group, a photo from baileys_auth_info/, everyone)
//   3. setDirectChatColorScheme(dm, 'Emerald@Tonal', everyone)
// Each step relays a CHAT_THEME_SETTING protocol message. A resolved
// call only means the stanza was written to the socket — the real
// check is on the phone: the group/DM background and bubbles change,
// and a system message says who changed the theme.
// The theme is left set; reset it with resetGroupWallpaper /
// resetDirectChatWallpaper, or clearChatTheme, or from the phone.
import { Boom } from '@hapi/boom'
import { readFileSync, writeFileSync } from 'node:fs'
import makeWASocket, { fetchLatestBaileysVersion, makeCacheableSignalKeyStore, useMultiFileAuthState } from '../src'
import P from 'pino'

const AUTH_DIR = 'baileys_auth_info'
const logger = P({ level: 'warn' })
const GROUP_JID = process.argv[2] || '120363414160399028@g.us'
const DM_JID = process.argv[3] || '74346471137370@lid'
const WALLPAPER_FILE = `${AUTH_DIR}/media-AC73ABA7F2EDC393FC629F52E34BF08E.jpg`

const result: Record<string, unknown> = { groupJid: GROUP_JID, dmJid: DM_JID, at: new Date().toISOString() }
const save = () => writeFileSync(`${AUTH_DIR}/test-chat-theme.json`, JSON.stringify(result, null, 2))

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
	console.log(`connected as ${sock.user?.id}`)
	result.connectedAs = sock.user?.id

	// Log anything that arrives in the group/DM while we test — the
	// theme change may come back as a system/stub message.
	sock.ev.on('messages.upsert', ({ messages }) => {
		for (const msg of messages) {
			if (msg.key.remoteJid === GROUP_JID || msg.key.remoteJid === DM_JID) {
				console.log(
					`incoming ${msg.key.id} chat=${msg.key.remoteJid} fromMe=${msg.key.fromMe} stub=${(msg as { messageStubType?: number }).messageStubType ?? ''} keys=${Object.keys(msg.message || {}).join(',')}`
				)
			}
		}
	})

	console.log('1. group colour scheme Royal-Blue@Tonal ...')
	const scheme = await sock.setGroupColorScheme(GROUP_JID, 'Royal-Blue@Tonal', {
		scope: 'everyone',
		allowUnverifiedPartialUpdate: true
	})
	console.log('   sent:', JSON.stringify(scheme.key), scheme.submissionStatus)
	result.groupColorScheme = { key: scheme.key, submissionStatus: scheme.submissionStatus }
	save()

	console.log(`2. group wallpaper from ${WALLPAPER_FILE} ...`)
	const wallpaper = await sock.setGroupWallpaper(GROUP_JID, readFileSync(WALLPAPER_FILE), { scope: 'everyone' })
	console.log('   sent:', JSON.stringify(wallpaper.key), wallpaper.submissionStatus)
	result.groupWallpaper = { key: wallpaper.key, submissionStatus: wallpaper.submissionStatus }
	save()

	console.log('3. DM colour scheme Emerald@Tonal ...')
	const dm = await sock.setDirectChatColorScheme(DM_JID, 'Emerald@Tonal', {
		scope: 'everyone',
		allowUnverifiedPartialUpdate: true
	})
	console.log('   sent:', JSON.stringify(dm.key), dm.submissionStatus)
	result.dmColorScheme = { key: dm.key, submissionStatus: dm.submissionStatus }
	save()

	console.log('All three theme messages written. Waiting 30s for any echo/system message, then done.')
	await new Promise(resolve => setTimeout(resolve, 30_000))
	console.log('Chat theme test DONE. Theme left set — check the phone, then reset from the phone or with resetGroupWallpaper / clearChatTheme.')
	process.exit(0)
}

main().catch(err => {
	result.error = String(err?.message || err)
	console.error('TEST FAILED:', err)
	save()
	process.exit(1)
})

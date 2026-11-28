// Colour-scheme-only verification: set the group to a strong red
// scheme and the DM to purple, so the change is obvious on the phone.
// The group already has a custom wallpaper (from the earlier test),
// so this checks whether a colour-scheme-only update lands on top
// of an existing wallpaper.
// Usage: npx tsx ./Example/test-chat-theme-color.ts [group-jid] [dm-jid]
import { Boom } from '@hapi/boom'
import { writeFileSync } from 'node:fs'
import makeWASocket, { fetchLatestBaileysVersion, makeCacheableSignalKeyStore, useMultiFileAuthState } from '../src'
import P from 'pino'

const AUTH_DIR = 'baileys_auth_info'
const logger = P({ level: 'warn' })
const GROUP_JID = process.argv[2] || '120363414160399028@g.us'
const DM_JID = process.argv[3] || '74346471137370@lid'

const result: Record<string, unknown> = { groupJid: GROUP_JID, dmJid: DM_JID, at: new Date().toISOString() }
const save = () => writeFileSync(`${AUTH_DIR}/test-chat-theme-color.json`, JSON.stringify(result, null, 2))

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

	sock.ev.on('messages.upsert', ({ messages }) => {
		for (const msg of messages) {
			if (msg.key.remoteJid === GROUP_JID || msg.key.remoteJid === DM_JID) {
				console.log(
					`incoming ${msg.key.id} chat=${msg.key.remoteJid} fromMe=${msg.key.fromMe} stub=${(msg as { messageStubType?: number }).messageStubType ?? ''} keys=${Object.keys(msg.message || {}).join(',')}`
				)
			}
		}
	})

	console.log('1. group colour scheme Red@Tonal ...')
	const group = await sock.setGroupColorScheme(GROUP_JID, 'Red@Tonal', {
		scope: 'everyone',
		allowUnverifiedPartialUpdate: true
	})
	console.log('   sent:', JSON.stringify(group.key), group.submissionStatus)
	result.groupColorScheme = { scheme: 'Red@Tonal', key: group.key, submissionStatus: group.submissionStatus }
	save()

	console.log('2. DM colour scheme Tyrian-Purple@Tonal ...')
	const dm = await sock.setDirectChatColorScheme(DM_JID, 'Tyrian-Purple@Tonal', {
		scope: 'everyone',
		allowUnverifiedPartialUpdate: true
	})
	console.log('   sent:', JSON.stringify(dm.key), dm.submissionStatus)
	result.dmColorScheme = { scheme: 'Tyrian-Purple@Tonal', key: dm.key, submissionStatus: dm.submissionStatus }
	save()

	console.log('Both colour schemes written. Waiting 30s for any echo/system message, then done.')
	await new Promise(resolve => setTimeout(resolve, 30_000))
	console.log('Colour theme test DONE. Group bubbles should be red, DM bubbles purple — check the phones.')
	process.exit(0)
}

main().catch(err => {
	result.error = String(err?.message || err)
	console.error('TEST FAILED:', err)
	save()
	process.exit(1)
})

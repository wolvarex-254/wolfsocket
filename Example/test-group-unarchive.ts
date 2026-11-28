// Group unarchive test for wolfsocket.
// Usage: npx tsx ./Example/test-group-unarchive.ts [group-jid]
// Defaults to the WolfSocket test group. Connects with the saved session
// (no QR), calls sock.archiveChat(jid, false, []) and waits for the
// chats.update event confirming archived: false.
// Leaves the group UNARCHIVED. Session is never cleared by this script.
import { Boom } from '@hapi/boom'
import { writeFileSync } from 'node:fs'
import makeWASocket, {
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState
} from '../src'
import P from 'pino'

const AUTH_DIR = 'baileys_auth_info'
const logger = P({ level: 'warn' })
const jid = process.argv[2] || '120363414160399028@g.us'

const result: Record<string, unknown> = { groupJid: jid, at: new Date().toISOString() }
const save = () => writeFileSync(`${AUTH_DIR}/test-group-unarchive.json`, JSON.stringify(result, null, 2))

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

	const meta = await sock.groupMetadata(jid)
	result.metadata = { subject: meta.subject, participants: meta.participants.length }
	console.log(`group "${meta.subject}", ${meta.participants.length} participants`)

	const confirmed = new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), 15_000)
		sock.ev.on('chats.update', (updates) => {
			for (const u of updates) {
				if (u.id === jid && (u as { archived?: boolean }).archived === false) {
					clearTimeout(timer)
					resolve(true)
				}
			}
		})
	})

	await sock.archiveChat(jid, false, [])
	result.unarchiveCall = 'ok'
	console.log('archiveChat(jid, false) returned ok — waiting for chats.update confirmation...')
	const ok = await confirmed
	result.unarchivedConfirmedByEvent = ok
	console.log(ok ? 'CONFIRMED: chats.update reported archived: false' : 'NOT confirmed by chats.update within 15s (call still returned ok — check phone)')
	save()
	console.log(`result saved to ${AUTH_DIR}/test-group-unarchive.json`)
	console.log('Group left UNARCHIVED. Session NOT cleared.')
	process.exit(0)
}

main().catch((err) => {
	result.error = String(err?.message || err)
	console.error('TEST FAILED:', err)
	save()
	process.exit(1)
})

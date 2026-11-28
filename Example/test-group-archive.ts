// Group archive test for wolfsocket.
// Usage: npx tsx ./Example/test-group-archive.ts <invite-code | invite-link | group-jid>
// Steps: connect with saved session (no QR), resolve the group, join via
// invite if not already a member, send one test message so there is a
// definite last message, then sock.archiveChat(jid, true, [that message])
// and wait for the chats.update event confirming archived: true.
// Leaves the group ARCHIVED for Briton to verify on his phone.
// Session is never cleared by this script.
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
const input = process.argv[2]
if (!input) {
	console.log('usage: npx tsx ./Example/test-group-archive.ts <invite-code | invite-link | group-jid>')
	process.exit(2)
}

const inviteCode = input.includes('chat.whatsapp.com/')
	? input.split('chat.whatsapp.com/')[1].split(/[?#]/)[0]
	: input.endsWith('@g.us')
		? null
		: input
const groupJidArg = input.endsWith('@g.us') ? input : null

const result: Record<string, unknown> = { input, inviteCode, groupJidArg, at: new Date().toISOString() }
const save = () => writeFileSync(`${AUTH_DIR}/test-group-archive.json`, JSON.stringify(result, null, 2))

const main = async () => {
	const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
	const { version } = await fetchLatestBaileysVersion()
	const sock = makeWASocket({
		version,
		logger,
		auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }
	})
	sock.ev.on('creds.update', saveCreds)

	const open = await new Promise<void>((resolve, reject) => {
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

	// Resolve the group
	let jid = groupJidArg
	if (inviteCode) {
		const info = await sock.groupGetInviteInfo(inviteCode)
		jid = info.id
		result.inviteInfo = { id: info.id, subject: info.subject, owner: info.owner, participants: info.participants?.length }
		console.log(`invite -> ${info.id} "${info.subject}" (${info.participants?.length ?? '?'} participants)`)
	}
	if (!jid) throw new Error('could not resolve group JID')
	result.groupJid = jid

	const meta = await sock.groupMetadata(jid)
	const me = sock.user?.id
	const isMember = meta.participants.some(p => p.id === me || p.id === (me as string)?.split(':')[0] + '@s.whatsapp.net' || (me as string)?.startsWith(p.id.split('@')[0]))
	result.metadata = { subject: meta.subject, participants: meta.participants.length, isMember }
	console.log(`group "${meta.subject}", ${meta.participants.length} participants, am I a member: ${isMember}`)

	if (!isMember) {
		if (!inviteCode) throw new Error('not a member and no invite code to join with')
		const joined = await sock.groupAcceptInvite(inviteCode)
		result.joinedJid = joined
		console.log(`joined group via invite: ${joined}`)
		await new Promise(r => setTimeout(r, 3000))
	}

	// Watch for the archive confirmation
	const archiveConfirmed = new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), 15_000)
		sock.ev.on('chats.update', (updates) => {
			for (const u of updates) {
				if (u.id === jid && (u as { archived?: boolean }).archived === true) {
					clearTimeout(timer)
					resolve(true)
				}
			}
		})
	})

	// Send one test message so archive has a definite last message
	const sent = await sock.sendMessage(jid, { text: 'wolfsocket archive test — hello from Kip' })
	result.sentMessageId = sent?.key?.id
	console.log(`sent test message ${sent?.key?.id}`)
	const lastMessages = sent?.key?.id && sent?.messageTimestamp
		? [{ key: sent.key, messageTimestamp: sent.messageTimestamp }]
		: []
	result.lastMessagesCount = lastMessages.length

	// Archive it
	await sock.archiveChat(jid, true, lastMessages as never)
	result.archiveCall = 'ok'
	console.log('archiveChat(jid, true) returned ok — waiting for chats.update confirmation...')
	const confirmed = await archiveConfirmed
	result.archivedConfirmedByEvent = confirmed
	console.log(confirmed ? 'CONFIRMED: chats.update reported archived: true' : 'NOT confirmed by chats.update within 15s (call still returned ok — check phone)')
	save()
	console.log(`result saved to ${AUTH_DIR}/test-group-archive.json`)
	console.log('Group left ARCHIVED for Briton to verify on his phone. Session NOT cleared.')
	process.exit(0)
}

main().catch((err) => {
	result.error = String(err?.message || err)
	console.error('TEST FAILED:', err)
	save()
	process.exit(1)
})

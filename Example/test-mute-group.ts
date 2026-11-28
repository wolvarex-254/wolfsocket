/**
 * Live test: mute / unmute the WolfSocket group via chatModify.
 *
 * Usage:
 *   npx tsx ./Example/test-mute-group.ts mute [minutes]   (default 60)
 *   npx tsx ./Example/test-mute-group.ts unmute
 *
 * Mute is a server-side app-state patch (index ['mute', jid],
 * type 'regular_high', apiVersion 2) with muteEndTimestamp set to an
 * absolute timestamp — Date.now() + duration. Unmute sends
 * mute: null. The phone should show the group muted (bell with a
 * line through it) and stop notifying for it until the mute ends.
 * The process exits after the patch is confirmed; the mute itself
 * lives on the server, not in this process.
 */

import makeWASocket, { useMultiFileAuthState, Browsers } from '../src'
import { writeFileSync } from 'fs'

const AUTH_DIR = 'baileys_auth_info'
const GROUP_JID = process.argv[2] === '--group' ? process.argv[3]! : '120363414160399028@g.us'
const MODE = process.argv.includes('unmute') ? 'unmute' : 'mute'
const MINUTES = Number(process.argv.find(a => /^\d+$/.test(a))) || 60

const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

const sock = makeWASocket({
	auth: state,
	browser: Browsers.macOS('Chrome'),
})

sock.ev.on('creds.update', saveCreds)

sock.ev.on('chats.update', updates => {
	for (const u of updates) {
		if (u.id === GROUP_JID) {
			console.log('chats.update for group:', JSON.stringify(u))
		}
	}
})

await new Promise<void>(resolve => {
	sock.ev.on('connection.update', ({ connection }) => {
		if (connection === 'open') resolve()
	})
})

console.log('connected as', sock.user?.id)

const result: Record<string, unknown> = { mode: MODE, group: GROUP_JID, at: new Date().toISOString() }
if (MODE === 'mute') {
	const muteEnd = Date.now() + MINUTES * 60_000
	await sock.chatModify({ mute: muteEnd }, GROUP_JID)
	result.muteEndTimestamp = muteEnd
	result.muteEndsAt = new Date(muteEnd).toISOString()
	console.log(`muted group for ${MINUTES} min, until ${result.muteEndsAt}`)
} else {
	await sock.chatModify({ mute: null }, GROUP_JID)
	console.log('unmuted group')
}

// give the server echo a moment to come back as chats.update
await new Promise(r => setTimeout(r, 10_000))
writeFileSync(`${AUTH_DIR}/test-mute-group.json`, JSON.stringify(result, null, 2))
console.log('wrote', `${AUTH_DIR}/test-mute-group.json`)
process.exit(0)

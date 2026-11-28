// Theme command bot: type commands in the WolfSocket group (or the
// DM with the second account) and the bot changes the chat theme.
// Usage: npx tsx ./Example/theme-command.ts [--selftest]
//   --selftest  sends ".theme list" once after connecting, so you can
//               see the full loop (send -> receive -> reply) in the log.
//
// Commands (only from the owner accounts — the linked number and the
// second account — other participants are ignored):
//   .theme <name>     set the colour scheme, e.g. .theme red
//   .theme list        show the known colour schemes
//   .theme clear       remove the theme entirely
//   .wallpaper         set the wallpaper from the attached image, or
//                      from the image you reply to
//   .wallpaper reset   back to WhatsApp's default wallpaper
//   .theme help        show this list in the chat
//
// Colour names: royal-blue, red, emerald, green, pink, purple,
// default. A full id like Royal-Blue@Tonal works too.
import { Boom } from '@hapi/boom'
import makeWASocket, { downloadMediaMessage, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, useMultiFileAuthState } from '../src'
import type { WAMessage } from '../src'
import P from 'pino'

const AUTH_DIR = 'baileys_auth_info'
const logger = P({ level: 'warn' })
const ARGS = process.argv.slice(2).filter(a => !a.startsWith('--'))
const GROUP_JID = ARGS[0] || '120363414160399028@g.us'
const DM_JID = '74346471137370@lid'
// Both accounts are Briton's; only their messages may run commands.
const OWNERS = new Set(['161031913480224@lid', '74346471137370@lid'])
const SELFTEST = process.argv.includes('--selftest')

const SCHEMES: Record<string, string> = {
	'royal-blue': 'Royal-Blue@Tonal',
	blue: 'Royal-Blue@Tonal',
	red: 'Red@Tonal',
	emerald: 'Emerald@Tonal',
	green: 'WhatsApp-Green@Tonal',
	pink: 'Pink@Tonal',
	purple: 'Tyrian-Purple@Tonal',
	tyrian: 'Tyrian-Purple@Tonal',
	default: 'Default-Blue@Tonal'
}

const HELP = [
	'Theme commands:',
	'.theme <name> — set colour scheme (royal-blue, red, emerald, green, pink, purple, default)',
	'.theme list — show the colour schemes',
	'.theme clear — remove the theme',
	'.wallpaper — set wallpaper from the attached image or the image you reply to',
	'.wallpaper reset — back to the default wallpaper'
].join('\n')

const normaliseScheme = (name: string) => {
	const lower = name.toLowerCase()
	if (SCHEMES[lower]) {
		return SCHEMES[lower]
	}
	if (lower.includes('@')) {
		return name
	}
	return `${name.charAt(0).toUpperCase()}${name.slice(1)}@Tonal`
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
	console.log(`theme-command bot connected as ${sock.user?.id}, listening on ${GROUP_JID} and ${DM_JID}`)

	const isGroup = (jid: string) => jid.endsWith('@g.us')
	const reply = (jid: string, text: string) => sock.sendMessage(jid, { text })

	const setScheme = async (jid: string, name: string) => {
		const scheme = normaliseScheme(name)
		const opts = { scope: 'everyone' as const, allowUnverifiedPartialUpdate: true }
		if (isGroup(jid)) {
			await sock.setGroupColorScheme(jid, scheme, opts)
		} else {
			await sock.setDirectChatColorScheme(jid, scheme, opts)
		}
		return scheme
	}

	const setWallpaper = async (jid: string, image: Buffer) => {
		const opts = { scope: 'everyone' as const }
		if (isGroup(jid)) {
			await sock.setGroupWallpaper(jid, image, opts)
		} else {
			await sock.setDirectChatWallpaper(jid, image, opts)
		}
	}

	const resetWallpaper = async (jid: string) => {
		const opts = { scope: 'everyone' as const }
		if (isGroup(jid)) {
			await sock.resetGroupWallpaper(jid, opts)
		} else {
			await sock.resetDirectChatWallpaper(jid, opts)
		}
	}

	const clearTheme = async (jid: string) => {
		await sock.clearChatTheme(jid)
	}

	const handle = async (msg: WAMessage) => {
		const jid = msg.key.remoteJid
		if (!jid || (jid !== GROUP_JID && jid !== DM_JID)) {
			return
		}
		const participant = (msg.key as { participant?: string }).participant
		if (!msg.key.fromMe && !(participant && OWNERS.has(participant))) {
			return
		}

		const content = msg.message
		const text = content?.conversation ?? content?.extendedTextMessage?.text ?? content?.imageMessage?.caption ?? ''
		if (!text.startsWith('.')) {
			return
		}
		const [cmd, ...rest] = text.trim().split(/\s+/)
		const arg = rest.join(' ')
		console.log(`command ${cmd} ${arg} in ${jid} from ${msg.key.fromMe ? 'me' : participant}`)

		try {
			if (cmd === '.theme' && arg.toLowerCase() === 'help') {
				await reply(jid, HELP)
			} else if (cmd === '.theme' && arg.toLowerCase() === 'list') {
				await reply(jid, `Colour schemes:\n${Object.entries(SCHEMES).map(([name, id]) => `- ${name} (${id})`).join('\n')}`)
			} else if (cmd === '.theme' && arg.toLowerCase() === 'clear') {
				await clearTheme(jid)
				await reply(jid, 'Theme cleared.')
			} else if (cmd === '.theme' && arg) {
				const scheme = await setScheme(jid, arg)
				await reply(jid, `Colour scheme set to ${scheme}.`)
			} else if (cmd === '.wallpaper' && arg.toLowerCase() === 'reset') {
				await resetWallpaper(jid)
				await reply(jid, 'Wallpaper reset to default.')
			} else if (cmd === '.wallpaper') {
				// Image attached to the command itself, or quoted in a reply.
				let imageMsg: WAMessage | undefined
				if (content?.imageMessage) {
					imageMsg = msg
				} else {
					const ctx = content?.extendedTextMessage?.contextInfo
					if (ctx?.quotedMessage?.imageMessage && ctx.stanzaId) {
						imageMsg = {
							key: { remoteJid: jid, id: ctx.stanzaId, fromMe: false },
							message: ctx.quotedMessage
						} as WAMessage
					}
				}
				if (!imageMsg) {
					await reply(jid, 'Send .wallpaper with a photo attached, or reply to a photo with .wallpaper.')
					return
				}
				const buf = (await downloadMediaMessage(imageMsg, 'buffer', {})) as Buffer
				await setWallpaper(jid, buf)
				await reply(jid, 'Wallpaper set.')
			} else {
				await reply(jid, HELP)
			}
		} catch (err) {
			console.error(`command ${cmd} failed:`, err)
			await reply(jid, `That didn't work: ${err instanceof Error ? err.message : String(err)}`)
		}
	}

	sock.ev.on('messages.upsert', ({ messages }) => {
		for (const msg of messages) {
			void handle(msg)
		}
	})

	if (SELFTEST) {
		console.log('selftest: sending .theme list ...')
		await sock.sendMessage(GROUP_JID, { text: '.theme list' })
	}

	console.log('theme-command bot running. Type .theme help in the group.')
}

main().catch(err => {
	console.error('BOT FAILED:', err)
	process.exit(1)
})

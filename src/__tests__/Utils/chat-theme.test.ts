import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import {
	resetGroupWallpaper,
	setDirectChatColorScheme,
	setGroupColorScheme,
	setGroupWallpaper
} from '../../Utils/chat-theme'
import { generateWAMessageContent } from '../../Utils/messages'

const upload = async () => ({ mediaUrl: 'https://mmg.test/enc', directPath: '/v/t62/enc' })
const OPTS = { upload } as never

const CHAT_THEME_SETTING = proto.Message.ProtocolMessage.Type.CHAT_THEME_SETTING

describe('generateWAMessageContent with chatTheme', () => {
	it('normalises a theme name to the colour-scheme form', async () => {
		const content = await generateWAMessageContent({ chatTheme: { chatThemeId: 'Royal-Blue' } }, OPTS)
		const setting = content.protocolMessage?.chatThemeSetting

		expect(content.protocolMessage?.type).toBe(CHAT_THEME_SETTING)
		expect(setting?.colorSchemeId).toBe('Royal-Blue@Tonal')
		// int64 fields come back as Long objects after fromObject
		expect(Number(setting?.settingTimestampMs)).toBeGreaterThan(Date.now() - 60_000)
	})

	it('keeps a complete colour-scheme id as given', async () => {
		const content = await generateWAMessageContent({ chatTheme: { colorSchemeId: 'Default-Blue@Minimal' } }, OPTS)

		expect(content.protocolMessage?.chatThemeSetting?.colorSchemeId).toBe('Default-Blue@Minimal')
	})

	it('encodes a solid-colour wallpaper as ARGB', async () => {
		const content = await generateWAMessageContent(
			{
				chatTheme: {
					solidColor: {
						colorLight: '#FFFFFFFF',
						colorDark: '#FF101010',
						doodleColorLight: '#FFCCE8FF',
						isDoodleEnabled: true
					}
				}
			},
			OPTS
		)
		const solid = content.protocolMessage?.chatThemeSetting?.solidColor

		expect(solid?.backgroundLightArgb).toBe(0xffffffff)
		expect(solid?.backgroundDarkArgb).toBe(0xff101010)
		expect(solid?.doodleLightArgb).toBe(0xffcce8ff)
		expect(solid?.isDoodleEnabled).toBe(true)
	})

	it('encodes a stock wallpaper with its dim level', async () => {
		const content = await generateWAMessageContent(
			{ chatTheme: { stockImage: { id: 'wallpaper-1', dimLevel: 0.25 } } },
			OPTS
		)
		const stock = content.protocolMessage?.chatThemeSetting?.stockImage

		expect(stock?.stockImageId).toBe('wallpaper-1')
		expect(stock?.dimLevel).toBe(0.25)
	})

	it('rejects an empty theme', async () => {
		await expect(generateWAMessageContent({ chatTheme: {} }, OPTS)).rejects.toMatchObject({
			output: { statusCode: 400 }
		})
	})

	it('round-trips through the wire format', async () => {
		const content = await generateWAMessageContent({ chatTheme: { chatThemeId: 'Emerald' } }, OPTS)
		const decoded = proto.Message.decode(proto.Message.encode(content).finish())

		expect(decoded.protocolMessage?.chatThemeSetting?.colorSchemeId).toBe('Emerald@Tonal')
	})
})

describe('group and direct-chat theme setters', () => {
	const makeSock = () => ({
		relayMessage: jest.fn(async () => undefined),
		waUploadToServer: jest.fn(async () => ({ directPath: '/v/t62/wallpaper' })),
		logger: {
			debug: jest.fn(),
			info: jest.fn(),
			warn: jest.fn(),
			error: jest.fn(),
			trace: jest.fn(),
			child: jest.fn()
		} as never,
		user: { id: '254785471416:3@s.whatsapp.net' }
	})

	it('relays a group colour scheme as a CHAT_THEME_SETTING protocol message', async () => {
		const sock = makeSock()

		const result = await setGroupColorScheme(sock, '120363414160399028@g.us', 'Royal-Blue@Tonal', {
			scope: 'everyone',
			allowUnverifiedPartialUpdate: true
		})

		expect(sock.relayMessage).toHaveBeenCalledTimes(1)
		const [jid, message, options] = sock.relayMessage.mock.calls[0] as unknown as [
			string,
			{ protocolMessage: { type: number; chatThemeSetting: { colorSchemeId?: string } } },
			{ additionalAttributes: { type: string } }
		]
		expect(jid).toBe('120363414160399028@g.us')
		expect(message.protocolMessage.type).toBe(CHAT_THEME_SETTING)
		expect(message.protocolMessage.chatThemeSetting.colorSchemeId).toBe('Royal-Blue@Tonal')
		expect(options.additionalAttributes).toEqual({ type: 'media' })
		expect(result.key).toEqual({ remoteJid: '120363414160399028@g.us', fromMe: true, id: expect.any(String) })
		expect(result.submissionStatus).toBe('written')
	})

	it('refuses a colour-scheme-only update without the partial-update acknowledgement', async () => {
		const sock = makeSock()

		await expect(
			setGroupColorScheme(sock as never, '120363414160399028@g.us', 'Royal-Blue@Tonal', { scope: 'everyone' })
		).rejects.toMatchObject({ output: { statusCode: 400 } })
		expect(sock.relayMessage).not.toHaveBeenCalled()
	})

	it('refuses a me-only scope', async () => {
		const sock = makeSock()

		await expect(
			setDirectChatColorScheme(sock as never, '74346471137370@lid', 'Royal-Blue@Tonal', {
				scope: 'me',
				allowUnverifiedPartialUpdate: true
			})
		).rejects.toMatchObject({ output: { statusCode: 400 } })
		expect(sock.relayMessage).not.toHaveBeenCalled()
	})

	it('resets a group wallpaper to the default', async () => {
		const sock = makeSock()

		await resetGroupWallpaper(sock, '120363414160399028@g.us', { scope: 'everyone' })

		const [, message] = sock.relayMessage.mock.calls[0] as unknown as [
			string,
			{ protocolMessage: { chatThemeSetting: { defaultWallpaper?: { isDoodleEnabled?: boolean } } } }
		]
		expect(message.protocolMessage.chatThemeSetting.defaultWallpaper).toEqual({ isDoodleEnabled: true })
	})

	it('uploads a custom wallpaper and references it by directPath', async () => {
		const sock = makeSock()

		await setGroupWallpaper(sock, '120363414160399028@g.us', Buffer.from('fake-image'), { scope: 'everyone' })

		expect(sock.waUploadToServer).toHaveBeenCalledTimes(1)
		const [, message] = sock.relayMessage.mock.calls[0] as unknown as [
			string,
			{ protocolMessage: { chatThemeSetting: { customImage?: { directPath?: string; mediaKey?: unknown } } } }
		]
		expect(message.protocolMessage.chatThemeSetting.customImage?.directPath).toBe('/v/t62/wallpaper')
		expect(message.protocolMessage.chatThemeSetting.customImage?.mediaKey).toBeDefined()
	})
})

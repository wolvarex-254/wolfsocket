import { Boom } from '@hapi/boom'
import { unlink } from 'node:fs/promises'
import { proto } from '../../WAProto/index.js'
import type { MediaType } from '../Defaults'
import type { WAMediaUpload } from '../Types'
import { generateMessageIDV2 } from './generics'
import type { ILogger } from './logger'
import { encryptedStream } from './messages-media'

/**
 * Chat themes (colour scheme + wallpaper) for a group or a DM.
 *
 * A theme is a CHAT_THEME_SETTING protocol message
 * (`proto.Message.ProtocolMessage.Type.CHAT_THEME_SETTING` carrying a
 * `ChatThemeSetting`: settingTimestampMs, colourSchemeId and one wallpaper
 * from the oneof). WhatsApp added shared themes in late 2026: picking a
 * theme asks whether to apply it for everyone or just for you, and a
 * change for everyone shows a system message in the chat naming who
 * changed it. This API only sends the for-everyone form — a 'me'-only
 * change is a client-local appearance setting with no verified
 * protocol operation, so it is refused rather than silently sent as
 * something else.
 *
 * Custom wallpapers are uploaded first as encrypted media with the
 * 'chat-wallpaper-image' media type, then referenced by directPath +
 * mediaKey + hashes in the theme setting, exactly as the phone client
 * does. A resolved promise only confirms the stanza was written to the
 * socket; it does not confirm server acceptance or that other clients
 * applied it.
 *
 * Sources: the ChatThemeSetting proto shape and the relay/upload flow
 * follow the plogme fork's chat-theme implementation
 * (`setGroupWallpaper` / `setGroupColorScheme` and the `chatTheme`
 * branch of `generateWAMessageContent`); the DM helpers mirror its
 * direct-chat variants. wolfsocket's own proto previously had none of
 * these definitions — they were added to WAProto.proto and regenerated
 * with `npm run gen:protobuf`.
 */

export type ChatThemeScope = 'everyone' | 'me'

export type ChatThemeOptions = {
	/** 'everyone' applies the theme for the whole chat; 'me' is rejected (no verified protocol operation). */
	scope?: ChatThemeScope
	/** wallpaper dim level 0-1 */
	dimLevel?: number
	/** upload timeout for a custom wallpaper image */
	mediaUploadTimeoutMs?: number
	/** protocol setting timestamp, defaults to now */
	settingTimestampMs?: number
	/** message id override */
	messageId?: string
}

export type ChatThemeResult = {
	key: { remoteJid: string; fromMe: boolean; id: string }
	message: { protocolMessage: { type: number; chatThemeSetting: proto.Message.IChatThemeSetting } }
	/** the stanza was written to the socket; server acceptance is unconfirmed */
	submissionStatus: 'written'
	serverOutcome: 'unconfirmed'
}

type ChatThemeSocket = {
	relayMessage: (
		jid: string,
		message: proto.IMessage,
		options: { messageId?: string; additionalAttributes?: { [_: string]: string } }
	) => Promise<unknown>
	waUploadToServer: (
		filePath: string,
		opts: { fileEncSha256B64: string; mediaType: MediaType; timeoutMs?: number }
	) => Promise<{ directPath?: string } | undefined>
	logger?: ILogger
	user?: { id?: string }
}

const assertScope = (scope: ChatThemeScope = 'everyone') => {
	if (scope === 'me') {
		throw new Boom('Client-only chat theme changes are not supported by this API. No message was sent.', {
			statusCode: 400
		})
	}

	if (scope !== 'everyone') {
		throw new Boom("Chat theme scope must be 'everyone' or 'me'.", { statusCode: 400 })
	}
}

const relayThemeSetting = async (
	sock: ChatThemeSocket,
	jid: string,
	setting: proto.Message.IChatThemeSetting,
	options: ChatThemeOptions = {}
): Promise<ChatThemeResult> => {
	if (!sock || typeof sock.relayMessage !== 'function') {
		throw new Boom('Chat theme changes require a connected socket', { statusCode: 400 })
	}

	if (typeof jid !== 'string' || !jid) {
		throw new Boom('Chat theme changes require a destination JID', { statusCode: 400 })
	}

	assertScope(options.scope)

	const message = {
		protocolMessage: {
			type: proto.Message.ProtocolMessage.Type.CHAT_THEME_SETTING,
			chatThemeSetting: setting
		}
	}
	const messageId = options.messageId || generateMessageIDV2(sock.user?.id)
	await sock.relayMessage(jid, message, {
		messageId,
		additionalAttributes: { type: 'media' }
	})

	return {
		key: { remoteJid: jid, fromMe: true, id: messageId },
		message,
		submissionStatus: 'written',
		serverOutcome: 'unconfirmed'
	}
}

const uploadWallpaper = async (
	sock: ChatThemeSocket,
	image: Buffer | { url: string } | string,
	options: ChatThemeOptions = {}
) => {
	if (!sock || typeof sock.waUploadToServer !== 'function' || typeof sock.relayMessage !== 'function') {
		throw new Boom('Custom wallpapers require a connected socket', { statusCode: 400 })
	}

	if (!Buffer.isBuffer(image) && typeof image !== 'string' && !(image && typeof image.url === 'string')) {
		throw new Boom('Wallpaper image must be a Buffer, URL, or local file path', { statusCode: 400 })
	}

	const media: WAMediaUpload = Buffer.isBuffer(image) ? image : typeof image === 'string' ? { url: image } : image
	const upload = await encryptedStream(media, 'chat-wallpaper-image', { logger: sock.logger })
	let directPath: string | undefined
	try {
		const uploaded = await sock.waUploadToServer(upload.encFilePath, {
			mediaType: 'chat-wallpaper-image',
			fileEncSha256B64: upload.fileEncSha256.toString('base64'),
			timeoutMs: options.mediaUploadTimeoutMs
		})
		directPath = uploaded?.directPath
	} finally {
		await unlink(upload.encFilePath).catch(() => undefined)
	}

	if (!directPath) {
		throw new Boom('Wallpaper upload returned no directPath', { statusCode: 502 })
	}

	return { upload, directPath }
}

const wallpaperSetting = (
	upload: Awaited<ReturnType<typeof uploadWallpaper>>['upload'],
	directPath: string,
	options: ChatThemeOptions = {}
): proto.Message.IChatThemeSetting => ({
	settingTimestampMs: options.settingTimestampMs ?? Date.now(),
	customImage: {
		directPath,
		mediaKey: upload.mediaKey,
		fileEncSha256: upload.fileEncSha256,
		fileSha256: upload.fileSha256,
		dimLevel: options.dimLevel ?? 0
	}
})

/**
 * Upload and apply a custom wallpaper for everyone in a group chat.
 * Pass `null` as the image to restore WhatsApp's default wallpaper.
 */
export const setGroupWallpaper = async (
	sock: ChatThemeSocket,
	jid: string,
	image: Buffer | { url: string } | string | null,
	options: ChatThemeOptions = {}
): Promise<ChatThemeResult> => {
	assertScope(options.scope)
	if (image === null) {
		return resetGroupWallpaper(sock, jid, options)
	}

	if (typeof jid !== 'string' || !jid) {
		throw new Boom('Group wallpaper changes require a destination JID', { statusCode: 400 })
	}

	const { upload, directPath } = await uploadWallpaper(sock, image, options)
	return relayThemeSetting(sock, jid, wallpaperSetting(upload, directPath, options), options)
}

/** Restore a group's wallpaper to WhatsApp's default design. */
export const resetGroupWallpaper = async (
	sock: ChatThemeSocket,
	jid: string,
	options: ChatThemeOptions & { isDoodleEnabled?: boolean } = {}
): Promise<ChatThemeResult> => {
	assertScope(options.scope)
	return relayThemeSetting(
		sock,
		jid,
		{
			settingTimestampMs: options.settingTimestampMs ?? Date.now(),
			defaultWallpaper: { isDoodleEnabled: options.isDoodleEnabled ?? true }
		},
		options
	)
}

/**
 * Apply only a chat colour scheme for everyone in a group.
 * The wallpaper field is omitted, so whether the existing wallpaper is
 * preserved is unverified — pass `allowUnverifiedPartialUpdate: true`
 * to acknowledge that.
 */
export const setGroupColorScheme = async (
	sock: ChatThemeSocket,
	jid: string,
	colorSchemeId: string,
	options: ChatThemeOptions & { allowUnverifiedPartialUpdate?: boolean } = {}
): Promise<ChatThemeResult> => {
	if (options.scope === 'me') {
		assertScope('me')
	}

	if (options.scope !== 'everyone') {
		throw new Boom("setGroupColorScheme requires an explicit scope of 'everyone'.", { statusCode: 400 })
	}

	if (options.allowUnverifiedPartialUpdate !== true) {
		throw new Boom(
			'A color-scheme-only update has unverified wallpaper-preservation semantics. Set allowUnverifiedPartialUpdate: true to send it.',
			{ statusCode: 400 }
		)
	}

	if (typeof colorSchemeId !== 'string' || !colorSchemeId.trim()) {
		throw new Boom('setGroupColorScheme requires a non-empty colorSchemeId', { statusCode: 400 })
	}

	return relayThemeSetting(
		sock,
		jid,
		{
			settingTimestampMs: options.settingTimestampMs ?? Date.now(),
			colorSchemeId: colorSchemeId.trim()
		},
		options
	)
}

/**
 * Upload and apply a custom wallpaper for everyone in a one-to-one chat.
 * Pass `null` as the image to restore WhatsApp's default wallpaper.
 */
export const setDirectChatWallpaper = async (
	sock: ChatThemeSocket,
	jid: string,
	image: Buffer | { url: string } | string | null,
	options: ChatThemeOptions = {}
): Promise<ChatThemeResult> => {
	assertScope(options.scope)
	if (image === null) {
		return resetDirectChatWallpaper(sock, jid, options)
	}

	if (typeof jid !== 'string' || !jid) {
		throw new Boom('Direct-chat wallpaper changes require a destination JID', { statusCode: 400 })
	}

	const { upload, directPath } = await uploadWallpaper(sock, image, options)
	return relayThemeSetting(sock, jid, wallpaperSetting(upload, directPath, options), options)
}

/** Restore a one-to-one chat's wallpaper to WhatsApp's default design. */
export const resetDirectChatWallpaper = async (
	sock: ChatThemeSocket,
	jid: string,
	options: ChatThemeOptions & { isDoodleEnabled?: boolean } = {}
): Promise<ChatThemeResult> => {
	assertScope(options.scope)
	return relayThemeSetting(
		sock,
		jid,
		{
			settingTimestampMs: options.settingTimestampMs ?? Date.now(),
			defaultWallpaper: { isDoodleEnabled: options.isDoodleEnabled ?? true }
		},
		options
	)
}

/**
 * Apply only a chat colour scheme for everyone in a one-to-one chat.
 * Same unverified-partial-update caveat as `setGroupColorScheme`.
 */
export const setDirectChatColorScheme = async (
	sock: ChatThemeSocket,
	jid: string,
	colorSchemeId: string,
	options: ChatThemeOptions & { allowUnverifiedPartialUpdate?: boolean } = {}
): Promise<ChatThemeResult> => {
	if (options.scope === 'me') {
		assertScope('me')
	}

	if (options.scope !== 'everyone') {
		throw new Boom("setDirectChatColorScheme requires an explicit scope of 'everyone'.", { statusCode: 400 })
	}

	if (options.allowUnverifiedPartialUpdate !== true) {
		throw new Boom(
			'A color-scheme-only update has unverified wallpaper-preservation semantics. Set allowUnverifiedPartialUpdate: true to send it.',
			{ statusCode: 400 }
		)
	}

	if (typeof colorSchemeId !== 'string' || !colorSchemeId.trim()) {
		throw new Boom('setDirectChatColorScheme requires a non-empty colorSchemeId', { statusCode: 400 })
	}

	return relayThemeSetting(
		sock,
		jid,
		{
			settingTimestampMs: options.settingTimestampMs ?? Date.now(),
			colorSchemeId: colorSchemeId.trim()
		},
		options
	)
}

/** Remove a chat's theme entirely. */
export const clearChatTheme = async (
	sock: ChatThemeSocket,
	jid: string,
	options: ChatThemeOptions = {}
): Promise<ChatThemeResult> => {
	assertScope(options.scope)
	return relayThemeSetting(
		sock,
		jid,
		{
			settingTimestampMs: options.settingTimestampMs ?? Date.now(),
			clearTheme: true
		},
		options
	)
}

import { prepareWAMessageMedia } from '../../Utils/messages'
import type { ILogger } from '../../Utils/logger'

const WEBP_PIXEL = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==', 'base64')

const logger = {
	level: 'silent',
	child: () => logger,
	trace: () => {},
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {}
} as ILogger

describe('prepareWAMessageMedia sticker flags', () => {
	it('preserves enhanced sticker fields in the final protobuf', async () => {
		const content = await prepareWAMessageMedia(
			{
				sticker: WEBP_PIXEL,
				isAiSticker: true,
				isAvatar: false,
				isLottie: false,
				accessibilityLabel: 'Premium sticker'
			},
			{
				logger,
				upload: async () => ({
					mediaUrl: 'https://mmg.whatsapp.net/test',
					directPath: '/test/sticker.enc'
				})
			}
		)

		expect(content.stickerMessage).toMatchObject({
			isAiSticker: true,
			isAvatar: false,
			isLottie: false,
			accessibilityLabel: 'Premium sticker'
		})
		expect(Number(content.stickerMessage?.stickerSentTs)).toBeGreaterThan(0)
	})
})

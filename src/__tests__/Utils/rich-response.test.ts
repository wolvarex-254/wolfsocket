import { generateWAMessageContent, parseMarkdownTables } from '../../Utils'

describe('native markdown tables', () => {
	it('parses prose and a Markdown table into rich submessages', () => {
		const result = parseMarkdownTables(
			'Here are the results:\n\n| Name | Score |\n| :--- | ---: |\n| Wolf | 99 |',
			{ title: 'Leaderboard' }
		)

		expect(result).toEqual([
			{ messageType: 2, messageText: 'Here are the results:' },
			{
				messageType: 4,
				tableMetadata: {
					title: 'Leaderboard',
					rows: [
						{ items: ['Name', 'Score'], isHeading: true },
						{ items: ['Wolf', '99'], isHeading: false }
					]
				}
			}
		])
	})

	it('creates the bot-forwarded native rich-response envelope', async () => {
		const message = await generateWAMessageContent(
			{ markdownTable: '| A | B |\n| --- | --- |\n| 1 | 2 |' },
			{} as never
		)

		const rich = message.botForwardedMessage?.message?.richResponseMessage
		expect(rich?.messageType).toBe(1)
		expect(rich?.submessages?.[0]?.messageType).toBe(4)
		expect(rich?.submessages?.[0]?.tableMetadata?.rows).toHaveLength(2)
		expect(rich?.contextInfo).toMatchObject({
			forwardingScore: 1,
			isForwarded: true,
			forwardOrigin: 4,
			forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' }
		})
	})
})

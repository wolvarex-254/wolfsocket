# wolfsocket

`wolfsocket` is a [Baileys](https://github.com/WhiskeySockets/Baileys) fork maintained by **WOLF TECH**. It preserves the upstream API while adding native group-status messages, enhanced sticker fields, and native WhatsApp table rendering for Markdown AI responses.

## Installation

```bash
npm install wolfsocket
```

The package is ESM and requires Node.js 20 or newer.

## Quick start

```js
import makeWASocket, { useMultiFileAuthState } from 'wolfsocket'

const { state, saveCreds } = await useMultiFileAuthState('auth_info')
const sock = makeWASocket({ auth: state })
sock.ev.on('creds.update', saveCreds)
```

## Native Markdown tables

Send an AI response containing Markdown pipe tables through `markdownTable`. WhatsApp renders each detected table with its native rich-table interface while preserving surrounding prose.

```js
const aiResponse = `Current plans:

| Plan | Storage | Price |
| --- | ---: | ---: |
| Basic | 10 GB | $5 |
| Pro | 100 GB | $15 |

Choose the plan that works for you.`

await sock.sendMessage(jid, {
	markdownTable: aiResponse,
	tableTitle: 'Plan comparison'
})
```

Supported behavior:

- Multiple tables in one response
- Text before, between, and after tables
- Native heading and data rows
- Escaped pipe characters (`\|`)
- Optional title for the first table
- Validation that every row has the same number of columns

The lower-level helpers are also exported:

```js
import { parseMarkdownTables, markdownToAIRichResponse } from 'wolfsocket'

const submessages = parseMarkdownTables(markdown, { title: 'Results' })
const richResponse = markdownToAIRichResponse(markdown, { title: 'Results' })
```

## Article cards

Send a WhatsApp external-ad reply card with `sock.sendArticleCard()`. The card metadata is encoded in `contextInfo.externalAdReply`.

```js
await sock.sendArticleCard(jid, {
	text: 'Learn more in these articles:',
	title: 'How to create and share a status',
	body: 'WhatsApp Help Center',
	url: 'https://faq.whatsapp.com/123456',
	thumbnailUrl: 'https://example.com/help-center.png',
	mediaType: 1,
	renderLargerThumbnail: true,
	showAdAttribution: true
})
```

`text`, `body`, and `thumbnailUrl` are optional. `mediaType` accepts the protobuf image (`1`) or video (`2`) value. WhatsApp controls the final card appearance and attribution label.

## Group status

`sendGroupStatus()` posts an update visible only inside a particular WhatsApp group. The group JID must end in `@g.us`.

```js
await sock.sendGroupStatus(groupJid, { text: 'Hello, group!' })

await sock.sendGroupStatus(groupJid, {
	image: imageBuffer,
	caption: 'New image'
})

await sock.sendGroupStatus(groupJid, {
	video: videoBuffer,
	caption: 'New video'
})

await sock.sendGroupStatus(groupJid, {
	audio: audioBuffer,
	mimetype: 'audio/ogg; codecs=opus',
	ptt: true
})

await sock.sendGroupStatus(groupJid, { sticker: stickerBuffer })
```

### `sock.sendGroupStatus(jid, content)`

| Parameter | Type | Description |
| --- | --- | --- |
| `jid` | `string` | Target group JID (`...@g.us`) |
| `content` | `AnyMessageContent` | Content accepted by `sock.sendMessage()` |

Returns a `Promise<WAMessage>` containing the sent message key.

## Enhanced sticker fields

The regular message API supports additional sticker properties represented by the current WhatsApp protobuf:

```js
await sock.sendMessage(jid, {
	sticker: webpBuffer,
	isAiSticker: true,
	isAvatar: false,
	isLottie: false,
	accessibilityLabel: 'AI-generated sticker'
})
```

These fields do not convert a WebP file into WhatsApp's signed premium `application/was` sticker format.

## Differences from upstream Baileys

- Adds `sock.sendGroupStatus()` for text and media group-status updates.
- Adds Markdown-to-native-table parsing through the `markdownTable` message property.
- Adds `sock.sendArticleCard()` for external-ad reply article cards.
- Exports `parseMarkdownTables()` and `markdownToAIRichResponse()`.
- Supports enhanced sticker protobuf fields.
- Fixes media stanza detection required by group-status messages.

All other standard Baileys APIs remain available.

## License

MIT. See [LICENSE](./LICENSE). The original Baileys copyright notice is preserved. Modifications by Briton Kiplangat (Silent Wolf) / WOLF TECH are licensed under the same terms.

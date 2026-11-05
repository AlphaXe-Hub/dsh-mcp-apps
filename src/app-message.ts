import { MAX_APP_MESSAGE_BLOCKS, MAX_APP_MESSAGE_TEXT_CHARS } from './constants'

/**
 * Unicode tag characters (U+E0000-U+E007F) and bidirectional control
 * characters render as nothing in a transcript while the model reads the full
 * text — reject them so a reviewer can see everything the message says.
 */
const INVISIBLE_CHAR_PATTERN = /[\u061C\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/u

export interface AppTextBlock {
  type: 'text'
  text: string
}

export type AppMessageValidation =
  | { ok: true; content: AppTextBlock[] }
  | { ok: false; reason: string }

/**
 * Validate a ui/message content payload from an MCP App. Text-only, capped,
 * visible-only: rejects non-text blocks (no silent partial delivery), oversized
 * messages, invisible/bidirectional control characters, and whitespace-only
 * content (the human prompt path requires non-whitespace too).
 */
export function validateAppMessageContent(rawContent: unknown): AppMessageValidation {
  if (!Array.isArray(rawContent)) {
    return { ok: false, reason: 'Missing content array' }
  }
  if (rawContent.length > MAX_APP_MESSAGE_BLOCKS) {
    return { ok: false, reason: `Too many content blocks (max ${MAX_APP_MESSAGE_BLOCKS})` }
  }
  const content: AppTextBlock[] = []
  let totalChars = 0
  for (const block of rawContent) {
    if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text' || typeof (block as { text?: unknown }).text !== 'string') {
      return { ok: false, reason: 'Only text content blocks are supported' }
    }
    const text = (block as { text: string }).text
    if (INVISIBLE_CHAR_PATTERN.test(text)) {
      return { ok: false, reason: 'Message contains invisible or bidirectional control characters' }
    }
    totalChars += text.length
    if (totalChars > MAX_APP_MESSAGE_TEXT_CHARS) {
      return { ok: false, reason: `Message text too large (max ${MAX_APP_MESSAGE_TEXT_CHARS} characters)` }
    }
    content.push({ type: 'text', text })
  }
  if (content.length === 0 || !content.some(block => block.text.trim().length > 0)) {
    return { ok: false, reason: 'Message content is empty or whitespace-only' }
  }
  return { ok: true, content }
}

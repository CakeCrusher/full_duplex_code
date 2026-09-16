import { get_encoding as getEncoding } from 'tiktoken';

let encoders;
export function estimatedTokens(text) {
  // Live does not publish a tokenizer mapping. Use the larger of the two
  // modern public encodings, with room below the API's 500-token limit.
  encoders ??= ['o200k_base', 'cl100k_base'].map(name => getEncoding(name));
  return Math.max(...encoders.map(encoder => encoder.encode(text, [], []).length));
}

export function textFragments(text, prefix = '', limit = 460) {
  const characters = Array.from(text), parts = [];
  let offset = 0;
  while (offset < characters.length) {
    let low = 1, high = Math.min(characters.length - offset, 6000), length = 0;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const content = characters.slice(offset, offset + count).join('');
      if (estimatedTokens(prefix + content) <= limit) { length = count; low = count + 1; }
      else high = count - 1;
    }
    if (!length) throw new Error('Context label exceeds the append token allowance');
    parts.push(characters.slice(offset, offset + length).join('')); offset += length;
  }
  return parts;
}
